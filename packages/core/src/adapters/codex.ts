/**
 * OpenAI Codex adapter (CLI and IDE extension share the same files).
 *
 * Reads $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (default ~/.codex).
 * Each line is `{ timestamp, type, payload }` where `type` is one of
 * `session_meta`, `turn_context`, `response_item`, `event_msg`, …
 *
 * - Progress: the `update_plan` tool call (`{ plan: [{ step, status }] }`).
 * - Tokens: `event_msg/token_count.info.total_token_usage` (running totals).
 * - Plan limits: `event_msg/token_count.rate_limits.primary|secondary`.
 * - Status: `task_started` → working, `task_complete` → idle, `turn_aborted` → interrupted.
 *
 * Compressed rollouts (`.jsonl.zst`) are archives older than 7 days and are skipped.
 *
 * Codex Desktop (originator "Codex Desktop") writes the same files. Its own helper threads, such
 * as the guardian that checks commands under "approve for me", are marked
 * `session_meta.source: { "subagent": … }` and are not sessions of their own. It writes no
 * `user_message` events: the title comes from the person's message among the `response_item`s.
 *
 * A rollout stays in the folder of the day its session began: a session resumed days later
 * (`codex resume`, the TUI's thread list) writes on in an older folder. Those folders are looked
 * through once a minute for files written within the active window.
 */
import path from 'node:path';
import type { AdapterContext, Candidate } from '../adapter.ts';
import { JsonlSessionAdapter, staleness } from '../adapter.ts';
import type { Activity, AgentSession, DailyUsage, RateLimitWindow, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { progressOf, totalTokens } from '../model.ts';
import { findGitRoot, listDir, statSafe } from '../util/fs.ts';
import { contentText, firstLine, summarizeCommand, truncate } from '../util/text.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { addTaskDone, addWork, dayKey, parseTime } from '../util/time.ts';
import { LimitBook, type AgentLimits } from '../limits.ts';
import { LoopWatch, loopKey } from '../util/loop-watch.ts';

interface CodexState {
  file: string;
  id: string;
  cwd?: string;
  model?: string;
  isSubagent: boolean;
  version?: string;
  /** Who started it: `codex_cli_rs` (the TUI), `codex_vscode`, `codex_exec`, … */
  originator?: string;
  title?: string;
  /** The person's first message among the transcript's items, for Codex Desktop, which writes no `user_message` events. */
  promptTitle?: string;
  startedAt?: number;
  updatedAt: number;
  tokens?: TokenUsage;
  prevTotal: number;
  prevCost: number;
  costUsd?: number;
  daily: Record<string, DailyUsage>;
  context?: { used: number; window?: number };
  rateLimits?: RateLimitWindow[];
  tasks: TaskItem[];
  open: Map<string, Activity>;
  /** What tells a freeform tool's call apart from the next, for its loop: its input. */
  callKeys: Map<string, string>;
  activity?: Activity;
  phase: 'working' | 'idle' | 'interrupted' | 'error';
  phaseAt: number;
  errorText?: string;
  turns: number;
  turnSteps: number;
  turnStartedAt?: number;
  timer: TaskTimer;
  recent: Activity[];
  /** Actions that keep failing the same way. */
  loops: LoopWatch;
  /** The previous record's time, for the day's work time. */
  lastRecordAt?: number;
}

/**
 * The failure in a tool's output, or undefined when it worked. Shell output arrives as JSON
 * (`{ output, metadata: { exit_code } }`) or as text that states the exit code.
 */
export function codexFailure(output: unknown): string | undefined {
  let text = typeof output === 'string' ? output : output && typeof output === 'object' ? JSON.stringify(output) : '';
  if (!text) return undefined;
  let code: number | undefined;
  try {
    const j = JSON.parse(text) as { output?: unknown; metadata?: { exit_code?: unknown } };
    if (j && typeof j === 'object' && typeof j.metadata?.exit_code === 'number') {
      code = j.metadata.exit_code;
      if (typeof j.output === 'string') text = j.output;
    }
  } catch {
    // text output
  }
  if (code === undefined) {
    const m = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m.exec(text);
    if (m) code = Number(m[1]);
  }
  return code !== undefined && code !== 0 ? text : undefined;
}

function planStatus(s: unknown): TaskStatus {
  if (s === 'completed') return 'completed';
  if (s === 'in_progress') return 'in_progress';
  return 'pending';
}

function windowLabel(minutes: unknown, fallback: string): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return fallback;
  if (minutes >= 10_000 && minutes <= 10_200) return 'Weekly';
  if (minutes >= 1_380 && minutes <= 1_500) return 'Daily';
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Codex's tools that run a command: `shell` (argv), `shell_command` (one line, PowerShell on Windows), `exec_command`, … */
const SHELL_TOOLS = /^(?:shell|shell_command|exec_command|exec|unified_exec|container\.exec|local_shell)$/;

function describeCodexCall(name: string, args: Record<string, any>, at: number): Activity {
  if (SHELL_TOOLS.test(name)) {
    return { kind: 'command', label: 'Shell', detail: summarizeCommand(args.command ?? args.cmd), startedAt: at };
  }
  if (name === 'apply_patch') return { kind: 'tool', label: 'Editing files', startedAt: at };
  if (name === 'update_plan') return { kind: 'tool', label: 'Updating plan', startedAt: at };
  if (name === 'view_image') return { kind: 'tool', label: 'Viewing image', startedAt: at };
  if (name.includes('__')) {
    const [server, tool] = name.split('__', 2);
    return { kind: 'tool', label: `${server}: ${tool}`, startedAt: at };
  }
  return { kind: 'tool', label: name, startedAt: at };
}

/** How far back older day folders are looked through for resumed sessions, and how often. */
const RESUMED_DAYS = 90;
const RESUMED_SCAN_MS = 60_000;

export class CodexAdapter extends JsonlSessionAdapter<CodexState> {
  /** The account's plan windows, from every session's readings. */
  private readonly limitBook = new LimitBook();
  /** Rollouts in older day folders that were written lately: sessions resumed since they began. */
  private resumed: string[] = [];
  private resumedAt = -Infinity;

  limits(ctx: AdapterContext): AgentLimits | undefined {
    const windows = this.limitBook.windows(ctx.now());
    return windows.length ? { agent: this.id, agentLabel: this.label, windows } : undefined;
  }

  readonly id = 'codex';
  readonly label = 'Codex';

  protected async discover(ctx: AdapterContext): Promise<Candidate[]> {
    const home = ctx.env.CODEX_HOME || path.join(ctx.home, '.codex');
    const root = path.join(home, 'sessions');
    const now = ctx.now();
    const days = Math.max(1, Math.ceil(ctx.activeWindowMs / 86_400_000) + 1);
    const dirs = new Set<string>();
    for (let i = 0; i <= days; i += 1) {
      const d = new Date(now - i * 86_400_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      dirs.add(path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
      dirs.add(path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())));
    }
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      for (const f of await listDir(dir)) {
        if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, f.name);
        const st = await statSafe(file);
        if (st) {
          out.push({ path: file, mtimeMs: st.mtimeMs });
          seen.add(file);
        }
      }
    }
    // Sessions resumed days after they began write on in their first day's folder.
    if (now - this.resumedAt >= RESUMED_SCAN_MS) {
      this.resumedAt = now;
      const found: string[] = [];
      for (let i = days + 1; i <= RESUMED_DAYS; i += 1) {
        const d = new Date(now - i * 86_400_000);
        const pad = (n: number) => String(n).padStart(2, '0');
        for (const dir of new Set([
          path.join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())),
          path.join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())),
        ])) {
          if (dirs.has(dir)) continue;
          for (const f of await listDir(dir)) {
            if (!f.isFile() || !f.name.startsWith('rollout-') || !f.name.endsWith('.jsonl')) continue;
            const file = path.join(dir, f.name);
            const st = await statSafe(file);
            if (st && now - st.mtimeMs < ctx.activeWindowMs) found.push(file);
          }
        }
      }
      this.resumed = found;
    }
    for (const file of this.resumed) {
      if (seen.has(file)) continue;
      const st = await statSafe(file);
      if (st) out.push({ path: file, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  protected createState(file: string): CodexState {
    // "rollout-<time>-<thread id>.jsonl", or "…-<thread id>_<rollout id>.jsonl" for a reverted thread: the thread's id resumes it.
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i.exec(file);
    const daily: Record<string, DailyUsage> = {};
    return {
      file,
      id: m ? m[1] : path.basename(file, '.jsonl'),
      isSubagent: false,
      updatedAt: 0,
      prevTotal: 0,
      prevCost: 0,
      daily,
      tasks: [],
      open: new Map(),
      callKeys: new Map(),
      phase: 'idle',
      phaseAt: 0,
      turns: 0,
      turnSteps: 0,
      timer: new TaskTimer((at) => addTaskDone(daily, at)),
      recent: [],
      loops: new LoopWatch(),
    };
  }

  protected onRecord(st: CodexState, rec: unknown, ctx: AdapterContext): void {
    if (!rec || typeof rec !== 'object') return;
    const o = rec as Record<string, any>;
    const ts = parseTime(o.timestamp) ?? st.updatedAt;
    if (ts) {
      if (st.startedAt === undefined || ts < st.startedAt) st.startedAt = ts;
      if (ts > st.updatedAt) st.updatedAt = ts;
    }
    const p = o.payload;
    if (!p || typeof p !== 'object') return;
    if (ts) {
      // The agent's own items (calls, their output, reasoning, replies) close a stretch of its work.
      const agentWrote = o.type === 'response_item' && !(p.type === 'message' && p.role === 'user');
      if (agentWrote) addWork(st.daily, st.lastRecordAt, ts);
      if (st.lastRecordAt === undefined || ts > st.lastRecordAt) st.lastRecordAt = ts;
    }

    switch (o.type) {
      case 'session_meta': {
        if (typeof p.id === 'string') st.id = p.id;
        if (typeof p.cwd === 'string') st.cwd = p.cwd;
        if (typeof p.cli_version === 'string') st.version = p.cli_version;
        if (typeof p.originator === 'string') st.originator = p.originator;
        else if (typeof p.source === 'string') st.originator = p.source;
        if (p.parent_thread_id || p.agent_role || p.agent_nickname) st.isSubagent = true;
        // Codex Desktop's guardian ({ "subagent": { "other": "guardian" } }), reviews, spawned agents.
        if (p.source && typeof p.source === 'object' && 'subagent' in p.source) st.isSubagent = true;
        const started = parseTime(p.timestamp);
        if (started) st.startedAt = Math.min(st.startedAt ?? started, started);
        return;
      }
      case 'turn_context':
        if (typeof p.model === 'string') st.model = p.model;
        if (typeof p.cwd === 'string') st.cwd = p.cwd;
        return;
      case 'event_msg':
        this.onEvent(st, p, ts, ctx);
        return;
      case 'response_item':
        this.onItem(st, p, ts);
        return;
      default:
        return;
    }
  }

  private onEvent(st: CodexState, p: Record<string, any>, ts: number, ctx: AdapterContext): void {
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        st.phase = 'working';
        st.phaseAt = ts;
        st.turns += 1;
        st.turnSteps = 0;
        st.turnStartedAt = ts;
        st.activity = { kind: 'thinking', label: 'Thinking', startedAt: ts };
        return;
      case 'task_complete':
      case 'turn_complete':
        st.phase = 'idle';
        st.phaseAt = ts;
        st.open.clear();
        st.callKeys.clear();
        return;
      case 'turn_aborted':
        st.phase = 'interrupted';
        st.phaseAt = ts;
        st.open.clear();
        st.callKeys.clear();
        st.loops.reset();
        return;
      case 'error':
        st.phase = 'error';
        st.phaseAt = ts;
        st.errorText = firstLine(String(p.message ?? 'Error'), 120);
        return;
      case 'user_message':
        if (typeof p.message === 'string' && p.message.trim()) {
          const said = codexPrompt(p.message);
          if (said) st.title ??= firstLine(said, 100);
          st.loops.reset();
          if (st.phase !== 'working') {
            st.phase = 'working';
            st.phaseAt = ts;
          }
        }
        return;
      case 'agent_message':
        st.activity = { kind: 'message', label: 'Writing a reply', startedAt: ts };
        return;
      case 'token_count':
        this.onTokenCount(st, p, ts, ctx);
        return;
      default:
        return;
    }
  }

  private onTokenCount(st: CodexState, p: Record<string, any>, ts: number, ctx: AdapterContext): void {
    const info = p.info;
    if (info?.total_token_usage) {
      const t = info.total_token_usage;
      const cached = Number(t.cached_input_tokens) || 0;
      const tokens: TokenUsage = {
        input: Math.max(0, (Number(t.input_tokens) || 0) - cached),
        cacheRead: cached,
        cacheWrite: Number(t.cache_write_input_tokens) || 0,
        output: Number(t.output_tokens) || 0,
        reasoning: Number(t.reasoning_output_tokens) || 0,
      };
      const total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
      const cost = ctx.pricing.cost(st.model, {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite5m: tokens.cacheWrite,
        cacheWrite1h: 0,
      });
      const bucket = (st.daily[dayKey(ts)] ??= { tokens: 0, costUsd: 0 });
      bucket.tokens += Math.max(0, total - st.prevTotal);
      if (cost !== undefined) bucket.costUsd += Math.max(0, cost - st.prevCost);
      st.prevTotal = total;
      st.prevCost = cost ?? 0;
      st.tokens = tokens;
      st.costUsd = cost;
      const last = info.last_token_usage;
      if (last) {
        const used = Number(last.total_tokens) || Number(last.input_tokens) + Number(last.output_tokens) || 0;
        const window = Number(info.model_context_window) || undefined;
        st.context = { used, window };
      }
    }
    const rl = p.rate_limits;
    if (rl && typeof rl === 'object') {
      const windows: RateLimitWindow[] = [];
      for (const [key, fallback] of [
        ['primary', '5h'],
        ['secondary', 'Weekly'],
      ] as const) {
        const w = rl[key];
        if (!w || typeof w.used_percent !== 'number') continue;
        const resetsAt =
          typeof w.resets_at === 'number'
            ? w.resets_at * 1000
            : typeof w.resets_in_seconds === 'number'
              ? ts + w.resets_in_seconds * 1000
              : undefined;
        windows.push({
          label: windowLabel(w.window_minutes, fallback),
          usedPercent: w.used_percent,
          resetsAt,
          windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined,
        });
      }
      if (windows.length) {
        st.rateLimits = windows;
        for (const w of windows) this.limitBook.add(w, ts, ctx.now());
      }
    }
  }

  private onItem(st: CodexState, p: Record<string, any>, ts: number): void {
    switch (p.type) {
      case 'function_call': {
        const name = String(p.name ?? 'tool');
        const args = parseArgs(p.arguments);
        if (name === 'update_plan' && Array.isArray(args.plan)) {
          st.tasks = args.plan.map((item: any, i: number) => ({
            id: String(i + 1),
            title: String(item?.step ?? ''),
            status: planStatus(item?.status),
          }));
          st.timer.observe(st.tasks, ts);
        }
        const act = describeCodexCall(name, args, ts);
        if (typeof p.call_id === 'string') st.open.set(p.call_id, act);
        st.activity = act;
        st.turnSteps += 1;
        if (name !== 'update_plan') {
          st.recent.unshift(act);
          if (st.recent.length > 6) st.recent.length = 6;
          st.timer.step();
        }
        return;
      }
      case 'custom_tool_call': {
        // A freeform tool's input is plain text: for a shell, the command (Codex Desktop runs its commands this way).
        const name = String(p.name ?? 'tool');
        const input = typeof p.input === 'string' ? p.input : undefined;
        const act = describeCodexCall(name, input !== undefined ? { command: input } : {}, ts);
        if (typeof p.call_id === 'string') {
          st.open.set(p.call_id, act);
          // Its whole input tells one call from the next, also two long scripts that begin alike.
          if (input) st.callKeys.set(p.call_id, `${act.kind === 'command' ? 'command' : name}:${input.slice(0, 2_000)}`);
        }
        st.activity = act;
        st.turnSteps += 1;
        if (name !== 'update_plan') {
          st.recent.unshift(act);
          if (st.recent.length > 6) st.recent.length = 6;
          st.timer.step();
        }
        return;
      }
      case 'local_shell_call': {
        const act: Activity = { kind: 'command', label: 'Shell', detail: summarizeCommand(p.action?.command), startedAt: ts };
        if (typeof p.call_id === 'string') st.open.set(p.call_id, act);
        st.activity = act;
        st.turnSteps += 1;
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const done = typeof p.call_id === 'string' ? st.open.get(p.call_id) : undefined;
        if (done) {
          done.endedAt = ts;
          const key = st.callKeys.get(p.call_id) ?? loopKey(done);
          st.loops.observe(key, done, codexFailure(p.output), ts, st.tokens ? totalTokens(st.tokens) : undefined);
        }
        if (typeof p.call_id === 'string') {
          st.open.delete(p.call_id);
          st.callKeys.delete(p.call_id);
        }
        st.activity = { kind: 'thinking', label: 'Thinking', startedAt: ts };
        return;
      }
      case 'web_search_call':
        st.activity = { kind: 'tool', label: 'Searching the web', detail: truncate(String(p.action?.query ?? ''), 70) || undefined, startedAt: ts };
        return;
      case 'reasoning':
        st.activity = { kind: 'thinking', label: 'Thinking', startedAt: ts };
        return;
      case 'message':
        if (p.role === 'user') {
          const said = codexPrompt(contentText(p.content));
          if (said) {
            st.promptTitle ??= firstLine(said, 100);
            st.loops.reset();
          }
          return;
        }
        if (p.role === 'assistant' && contentText(p.content).trim()) {
          st.activity = { kind: 'message', label: 'Writing a reply', startedAt: ts };
        }
        return;
      default:
        return;
    }
  }

  protected toSession(st: CodexState, ctx: AdapterContext): AgentSession | undefined {
    if (!st.startedAt || st.isSubagent) return undefined;
    const prog = progressOf(st.tasks);
    let status: AgentSession['status'];
    let detail: string | undefined;
    switch (st.phase) {
      case 'working':
        status = 'working';
        break;
      case 'error':
        status = 'error';
        detail = st.errorText;
        break;
      case 'interrupted':
        status = 'idle';
        detail = 'Interrupted';
        break;
      default:
        status = prog.total > 0 && prog.done === prog.total ? 'done' : 'idle';
    }
    if (status === 'working') {
      const stale = staleness(st.updatedAt, ctx);
      if (stale) {
        status = 'stale';
        detail = stale;
      }
    }
    const activity = status === 'working' ? ([...st.open.values()].pop() ?? st.activity) : undefined;
    return {
      key: `codex:${st.id}`,
      agent: 'codex',
      agentLabel: this.label,
      id: st.id,
      title: st.title ?? st.promptTitle ?? 'Untitled session',
      titleFromPrompt: (st.title ?? st.promptTitle) !== undefined ? true : undefined,
      projectPath: st.cwd ? (findGitRoot(st.cwd) ?? st.cwd) : undefined,
      cwd: st.cwd,
      model: st.model,
      agentVersion: st.version,
      host: codexHost(st.originator),
      status,
      statusDetail: detail,
      startedAt: st.startedAt,
      updatedAt: st.updatedAt,
      tasks: st.tasks,
      activity,
      tokens: st.tokens ? { ...st.tokens } : undefined,
      costUsd: st.costUsd,
      daily: st.daily,
      context: st.context,
      rateLimits: st.rateLimits,
      turns: st.turns,
      turn: st.turnStartedAt !== undefined ? { steps: st.turnSteps, startedAt: st.turnStartedAt } : undefined,
      current: status === 'working' || status === 'stale' ? st.timer.current(st.tasks) : undefined,
      loop: loopOf(st, status, ctx.now()),
      recent: st.recent.slice(0, 5),
      sources: [st.file],
    };
  }
}

/**
 * The person's own words in a user message, or undefined for what Codex writes there itself: its
 * context (`<environment_context>`, `<user_instructions>`, AGENTS.md). From an editor, the request
 * follows the editor's context ("# Context from my IDE setup: … ## My request for Codex:").
 */
export function codexPrompt(text: string): string | undefined {
  let t = text.trim();
  const req = /^#{1,3}\s*My request for Codex:?[ \t]*$/im.exec(t);
  if (req) t = t.slice(req.index + req[0].length).trim();
  else if (/^#\s*Context from my IDE setup/i.test(t)) return undefined;
  if (!t || t.startsWith('<') || /^#\s*AGENTS\.md\b/i.test(t)) return undefined;
  return t;
}

/** Where a session runs, by the program that started it: `codex_cli_rs`, `codex_vscode`, `Codex Desktop`, `codex_exec`, … */
function codexHost(originator: string | undefined): AgentSession['host'] {
  if (originator === undefined) return undefined;
  if (/desktop/i.test(originator)) return 'app';
  if (/vscode|ide/.test(originator)) return 'editor';
  if (/exec|mcp|sdk/.test(originator)) return 'app';
  return 'terminal';
}

function loopOf(st: CodexState, status: AgentSession['status'], now: number): AgentSession['loop'] {
  const l = status === 'working' || status === 'stale' ? st.loops.current(now) : undefined;
  if (!l) return undefined;
  return {
    label: l.label,
    detail: l.detail,
    count: l.count,
    sameError: l.sameError,
    since: l.since,
    tokens: l.tokensAtStart !== undefined && st.tokens ? totalTokens(st.tokens) - l.tokensAtStart : undefined,
  };
}
