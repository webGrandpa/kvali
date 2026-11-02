/**
 * Claude Code adapter.
 *
 * Reads (all local, read-only):
 *   <config>/projects/<slug>/<sessionId>.jsonl          session transcript
 *   <config>/projects/<slug>/<sessionId>/subagents/*.jsonl   subagent transcripts (tokens only)
 *   <config>/projects/<slug>/agent-*.jsonl              subagent transcripts, older layout (tokens only)
 *   <config>/tasks/<sessionId>/*.json                   the session's task list (TaskCreate/TaskUpdate)
 *   <liveDir>/claude-code/<sessionId>.json              optional live state from Kvali's hooks
 * where <config> is $CLAUDE_CONFIG_DIR or ~/.claude.
 *
 * Progress comes from the agent's own plan: the Tasks tools (TaskCreate/TaskUpdate)
 * or the older TodoWrite tool. Tokens are summed from `message.usage`, de-duplicated
 * by message id because Claude Code writes one line per content block.
 */
import path from 'node:path';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { staleness } from '../adapter.ts';
import type { Activity, AgentSession, DailyUsage, PulsePhase, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { addTokens, emptyTokens, progressOf } from '../model.ts';
import { findGitRoot, listDir, readJsonSafe, statSafe } from '../util/fs.ts';
import { JsonlTail } from '../util/jsonl.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { contentText, firstLine, stripInjectedTags, summarizeCommand, truncate } from '../util/text.ts';
import { dayKey, parseTime } from '../util/time.ts';

type Phase = 'working' | 'tool' | 'idle' | 'interrupted' | 'error';

interface LiveState {
  event?: string;
  notificationType?: string;
  message?: string;
  toolName?: string;
  at?: number;
}

interface UsageBucket {
  seen: Set<string>;
}

interface ClaudeState {
  file: string;
  sessionId: string;
  projectDir: string;
  /** Directory the session was started in: it defines the project. */
  launchCwd?: string;
  version?: string;
  /** Current working directory (may change when the agent cds). */
  cwd?: string;
  model?: string;
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  firstPrompt?: string;
  startedAt?: number;
  updatedAt: number;
  usage: UsageBucket;
  tokens: TokenUsage;
  costUsd: number;
  pricedAll: boolean;
  daily: Record<string, DailyUsage>;
  context?: number;
  maxContext: number;
  todos?: TaskItem[];
  tasks: Map<string, TaskItem>;
  pendingCreates: Map<string, Omit<TaskItem, 'id'>>;
  taskDir?: { sig: string; tasks: TaskItem[] };
  open: Map<string, Activity>;
  activity?: Activity;
  phase: Phase;
  phaseAt: number;
  errorText?: string;
  turns: number;
  /** Tool calls in the current (or last) turn, and when it began. */
  turnSteps: number;
  turnStartedAt?: number;
  /**
   * A turn runs: from a prompt, or any other message that set the model going (a scheduled
   * wake-up, a task or PR notification, a slash command), until the model ends it.
   */
  turnOpen: boolean;
  /** When the turn closed, and the response that closed it (its other lines belong to it). */
  turnEndedAt?: number;
  turnEndedBy?: string;
  /** The last message on the person's side, whoever wrote it: what a new turn answers. */
  promptAt?: number;
  live?: LiveState & { mtimeMs: number };
  /** The heartbeat Kvali's Claude Code plugin writes from inside the session. */
  pulse?: PulseFile & { mtimeMs: number };
  subagents: Map<string, { tail: JsonlTail; updatedAt: number }>;
  timer: TaskTimer;
  recent: Activity[];
  trouble?: { message: string; at: number; attempt?: number; maxAttempts?: number };
  lastSubagentScan: number;
}

/** What Kvali's Claude Code plugin writes to `~/.kvali/live/claude-code/<session>.mod.json`. */
interface PulseFile {
  v: number;
  at: number;
  phase: string;
  since: number;
  label?: string;
  detail?: string;
  lastDataAt?: number;
  /** The plugin sends this session's phone notifications. */
  push?: boolean;
}

/** The plugin rewrites its heartbeat at least every 10 s while a turn runs. */
const PULSE_FRESH_MS = 30_000;
const PULSE_ACTIVE = new Set<PulsePhase>(['requesting', 'thinking', 'writing', 'tool-input', 'running', 'needs-you', 'stalled']);

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function normStatus(s: unknown): TaskStatus {
  switch (s) {
    case 'completed':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'in-progress':
    case 'active':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
    case 'deleted':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

function rel(file: unknown, cwd: string | undefined): string | undefined {
  if (typeof file !== 'string') return undefined;
  if (cwd && file.startsWith(cwd + path.sep)) return file.slice(cwd.length + 1);
  return file;
}

export function describeClaudeTool(name: string, input: Record<string, unknown>, cwd: string | undefined, at: number): Activity {
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = summarizeCommand(input.command);
      const desc = typeof input.description === 'string' ? input.description : undefined;
      return { kind: 'command', label: desc ? truncate(desc, 60) : name, detail: cmd, startedAt: at };
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'tool', label: name, detail: rel(input.file_path ?? input.notebook_path, cwd), startedAt: at };
    case 'Grep':
    case 'Glob':
      return { kind: 'tool', label: name, detail: typeof input.pattern === 'string' ? truncate(input.pattern, 60) : undefined, startedAt: at };
    case 'WebFetch':
      return { kind: 'tool', label: 'WebFetch', detail: typeof input.url === 'string' ? truncate(input.url, 70) : undefined, startedAt: at };
    case 'WebSearch':
      return { kind: 'tool', label: 'WebSearch', detail: typeof input.query === 'string' ? truncate(input.query, 70) : undefined, startedAt: at };
    case 'Task':
    case 'Agent': {
      const d = input.description ?? input.subagent_type ?? input.name;
      return { kind: 'subagent', label: 'Subagent', detail: typeof d === 'string' ? truncate(d, 70) : undefined, startedAt: at };
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return { kind: 'tool', label: 'Updating plan', startedAt: at };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      if (mcp) return { kind: 'tool', label: `${mcp[1]}: ${mcp[2]}`, startedAt: at };
      return { kind: 'tool', label: name, startedAt: at };
    }
  }
}

export class ClaudeCodeAdapter implements Adapter {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  private readonly sessions = new Map<string, { tail: JsonlTail; state: ClaudeState }>();
  private readonly legacyAgents = new Map<string, { tail: JsonlTail; updatedAt: number }>();
  /** Per project directory: its mtime and the transcript files it held at the last scan. */
  private readonly dirCache = new Map<string, { mtimeMs: number; files: { file: string; mtimeMs: number }[] }>();
  private lastDiscovery = 0;
  private lastFullScan = 0;

  configDir(ctx: AdapterContext): string {
    const fromEnv = ctx.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim();
    return fromEnv || path.join(ctx.home, '.claude');
  }

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (this.sessions.size === 0 || now - this.lastDiscovery >= 5_000) {
      this.lastDiscovery = now;
      await this.discover(ctx);
    }

    const out: AgentSession[] = [];
    for (const entry of this.sessions.values()) {
      const res = await entry.tail.read(
        (rec) => this.onRecord(entry.state, rec, ctx, false),
        () => {
          entry.state = this.createState(entry.state.file);
        },
      );
      await this.readSideFiles(entry.state, ctx, res.changed);
    }
    await this.readLegacyAgents(ctx);
    for (const entry of this.sessions.values()) {
      const s = this.toSession(entry.state, ctx);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Finds recent transcripts. A directory is re-listed only when its mtime changes
   * (a new session file appeared) or once a minute (an old session was resumed), so
   * thousands of old transcripts cost one `stat` per project directory per scan.
   */
  private async discover(ctx: AdapterContext): Promise<void> {
    const now = ctx.now();
    const full = now - this.lastFullScan >= 60_000;
    if (full) this.lastFullScan = now;
    const projectsDir = path.join(this.configDir(ctx), 'projects');
    const found: { file: string; mtimeMs: number }[] = [];
    const legacy: { file: string; mtimeMs: number }[] = [];
    const seenDirs = new Set<string>();
    for (const d of await listDir(projectsDir)) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projectsDir, d.name);
      seenDirs.add(dir);
      const dst = await statSafe(dir);
      if (!dst) continue;
      let cached = this.dirCache.get(dir);
      if (full || !cached || cached.mtimeMs !== dst.mtimeMs) {
        const files: { file: string; mtimeMs: number }[] = [];
        for (const f of await listDir(dir)) {
          if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
          const file = path.join(dir, f.name);
          const st = await statSafe(file);
          if (st) files.push({ file, mtimeMs: st.mtimeMs });
        }
        cached = { mtimeMs: dst.mtimeMs, files };
        this.dirCache.set(dir, cached);
      }
      for (const f of cached.files) {
        // Tracked sessions keep their freshest mtime from the tail reader's own stat.
        const mtimeMs = Math.max(f.mtimeMs, this.sessions.get(f.file)?.state.updatedAt ?? 0);
        if (now - mtimeMs > ctx.activeWindowMs) continue;
        (path.basename(f.file).startsWith('agent-') ? legacy : found).push({ file: f.file, mtimeMs });
      }
    }
    for (const dir of [...this.dirCache.keys()]) if (!seenDirs.has(dir)) this.dirCache.delete(dir);
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Set(found.slice(0, ctx.maxSessionsPerAgent).map((f) => f.file));
    for (const file of keep) {
      if (!this.sessions.has(file)) this.sessions.set(file, { tail: new JsonlTail(file), state: this.createState(file) });
    }
    for (const file of [...this.sessions.keys()]) if (!keep.has(file)) this.sessions.delete(file);

    const keepLegacy = new Set(legacy.map((l) => l.file));
    for (const l of legacy) if (!this.legacyAgents.has(l.file)) this.legacyAgents.set(l.file, { tail: new JsonlTail(l.file), updatedAt: l.mtimeMs });
    for (const file of [...this.legacyAgents.keys()]) if (!keepLegacy.has(file)) this.legacyAgents.delete(file);
  }

  private createState(file: string): ClaudeState {
    return {
      file,
      sessionId: path.basename(file, '.jsonl'),
      projectDir: path.dirname(file),
      updatedAt: 0,
      usage: { seen: new Set() },
      tokens: emptyTokens(),
      costUsd: 0,
      pricedAll: true,
      daily: {},
      maxContext: 0,
      tasks: new Map(),
      pendingCreates: new Map(),
      open: new Map(),
      phase: 'idle',
      phaseAt: 0,
      turns: 0,
      turnSteps: 0,
      turnOpen: false,
      subagents: new Map(),
      timer: new TaskTimer(),
      recent: [],
      lastSubagentScan: 0,
    };
  }

  /** Folds one transcript line into state. `tokensOnly` is used for subagent transcripts. */
  private onRecord(st: ClaudeState, rec: unknown, ctx: AdapterContext, tokensOnly: boolean): void {
    if (!rec || typeof rec !== 'object') return;
    const o = rec as Record<string, any>;
    const ts = parseTime(o.timestamp);

    if (tokensOnly) {
      if (o.type === 'assistant' && o.message) this.countUsage(st, o, ts, ctx, false);
      return;
    }

    if (ts !== undefined) {
      if (st.startedAt === undefined || ts < st.startedAt) st.startedAt = ts;
      if (ts > st.updatedAt) st.updatedAt = ts;
    }
    if (typeof o.version === 'string') st.version = o.version;
    if (typeof o.cwd === 'string' && o.cwd) {
      st.cwd = o.cwd;
      st.launchCwd ??= o.cwd;
    }

    switch (o.type) {
      case 'summary':
        if (typeof o.summary === 'string') st.summary = o.summary;
        return;
      case 'ai-title':
        if (typeof o.aiTitle === 'string') st.aiTitle = o.aiTitle;
        return;
      case 'custom-title':
        if (typeof o.customTitle === 'string') st.customTitle = o.customTitle;
        else if (typeof o.title === 'string') st.customTitle = o.title;
        return;
      case 'assistant':
        this.onAssistant(st, o, ts ?? st.updatedAt, ctx);
        return;
      case 'user':
        this.onUser(st, o, ts ?? st.updatedAt);
        return;
      case 'system':
        if (o.subtype === 'compact_boundary') st.context = undefined;
        if (/error|retry/i.test(String(o.subtype ?? '')) || o.level === 'error' || o.level === 'warning') {
          const err = o.error && typeof o.error === 'object' ? o.error : {};
          const attempt = Number(o.retryAttempt ?? o.attempt ?? err.retryAttempt) || undefined;
          const max = Number(o.maxRetries ?? o.max_retries ?? err.maxRetries) || undefined;
          const message = firstLine(String(o.content ?? err.message ?? o.cause?.message ?? o.subtype ?? 'API problem'), 100);
          st.trouble = { message, at: ts ?? st.updatedAt, attempt, maxAttempts: max };
        }
        if (o.level === 'error' || o.subtype === 'api_error') {
          st.phase = 'error';
          st.phaseAt = ts ?? st.updatedAt;
          st.errorText = firstLine(String(o.content ?? o.error ?? 'API error'), 120);
        }
        return;
      default:
        return;
    }
  }

  private countUsage(st: ClaudeState, o: Record<string, any>, ts: number | undefined, ctx: AdapterContext, trackContext: boolean): void {
    const m = o.message;
    const u = m?.usage;
    if (!u || m.model === '<synthetic>') return;
    const id = `${m.id ?? ''}:${o.requestId ?? ''}`;
    if (id !== ':' && st.usage.seen.has(id)) return;
    st.usage.seen.add(id);

    const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
    const cw1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
    const cw5m = u.cache_creation ? Number(u.cache_creation.ephemeral_5m_input_tokens) || Math.max(0, cacheWrite - cw1h) : cacheWrite;
    const usage: TokenUsage = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite,
      reasoning: Number(u.output_tokens_details?.thinking_tokens) || 0,
    };
    addTokens(st.tokens, usage);
    const cost = ctx.pricing.cost(m.model, {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite5m: cw5m,
      cacheWrite1h: cw1h,
      speed: u.speed,
      inferenceGeo: u.inference_geo,
    });
    if (cost === undefined) st.pricedAll = false;
    else st.costUsd += cost;

    const day = dayKey(ts ?? ctx.now());
    const bucket = (st.daily[day] ??= { tokens: 0, costUsd: 0 });
    bucket.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    bucket.costUsd += cost ?? 0;

    if (trackContext) {
      const ctxTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      st.context = ctxTokens;
      if (ctxTokens > st.maxContext) st.maxContext = ctxTokens;
    }
  }

  private onAssistant(st: ClaudeState, o: Record<string, any>, ts: number, ctx: AdapterContext): void {
    const m = o.message;
    if (!m) return;
    if (o.isSidechain) {
      this.countUsage(st, o, ts, ctx, false);
      return;
    }
    if (typeof m.model === 'string' && m.model !== '<synthetic>') st.model = m.model;
    this.countUsage(st, o, ts, ctx, true);
    if (m.model !== '<synthetic>') st.trouble = undefined;

    if (o.isApiErrorMessage || (o.error && m.model === '<synthetic>')) {
      st.phase = 'error';
      st.phaseAt = ts;
      st.errorText = firstLine(contentText(m.content) || 'API error', 120);
      this.endTurn(st, ts, undefined);
      return;
    }

    // The model answers after its turn had ended: a new turn, whatever set it going (a person's
    // prompt starts one at once, in onUser). It is timed from the message it answers, if one came.
    const msgId = typeof m.id === 'string' ? m.id : undefined;
    if (!st.turnOpen && !(msgId && msgId === st.turnEndedBy)) {
      st.turnOpen = true;
      st.turnSteps = 0;
      st.turnStartedAt = st.promptAt !== undefined && st.promptAt >= (st.turnEndedAt ?? 0) ? st.promptAt : ts;
    }

    let sawToolUse = false;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        sawToolUse = true;
        this.onToolUse(st, block, ts);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        st.activity = { kind: 'thinking', label: 'Thinking', startedAt: ts };
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        st.activity = { kind: 'message', label: 'Writing a reply', startedAt: ts };
      }
    }

    const stop = m.stop_reason;
    if (sawToolUse || stop === 'tool_use' || stop === 'pause_turn') st.phase = 'tool';
    else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens' || stop === 'refusal') {
      st.phase = 'idle';
      st.open.clear();
      this.endTurn(st, ts, msgId);
    } else st.phase = 'working';
    st.phaseAt = ts;
  }

  private endTurn(st: ClaudeState, ts: number, by: string | undefined): void {
    st.turnOpen = false;
    st.turnEndedAt = ts;
    st.turnEndedBy = by;
  }

  private onToolUse(st: ClaudeState, block: Record<string, any>, ts: number): void {
    const name = String(block.name ?? 'tool');
    const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, any>;
    const act = describeClaudeTool(name, input, st.cwd, ts);
    if (typeof block.id === 'string') st.open.set(block.id, act);
    st.activity = act;
    st.turnSteps += 1;
    st.turnStartedAt ??= ts;
    const planTool = name === 'TodoWrite' || (name.startsWith('Task') && name !== 'Task');
    if (!planTool) {
      st.recent.unshift(act);
      if (st.recent.length > 6) st.recent.length = 6;
      st.timer.step();
    }

    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      st.todos = input.todos.map((t: any, i: number) => ({
        id: String(t?.id ?? i + 1),
        title: String(t?.content ?? t?.subject ?? ''),
        activeTitle: typeof t?.activeForm === 'string' ? t.activeForm : undefined,
        status: normStatus(t?.status),
      }));
      st.timer.observe(st.todos ?? [], ts);
    } else if (name === 'TaskCreate' && typeof block.id === 'string') {
      st.pendingCreates.set(block.id, {
        title: String(input.subject ?? input.title ?? ''),
        activeTitle: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        status: 'pending',
      });
    } else if (name === 'TaskUpdate' && input.taskId !== undefined) {
      const id = String(input.taskId);
      const t = st.tasks.get(id);
      if (input.status === 'deleted') st.tasks.delete(id);
      else if (t) {
        if (input.status) t.status = normStatus(input.status);
        if (typeof input.subject === 'string') t.title = input.subject;
        if (typeof input.activeForm === 'string') t.activeTitle = input.activeForm;
      }
      st.timer.observe([...st.tasks.values()], ts);
    }
  }

  private onUser(st: ClaudeState, o: Record<string, any>, ts: number): void {
    const m = o.message;
    if (!m || o.isSidechain) return;
    const content = m.content;

    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const pending = st.pendingCreates.get(b.tool_use_id);
        if (pending) {
          let id = o.toolUseResult?.task?.id;
          if (id === undefined) {
            const mm = /Task #?(\w+) created/i.exec(contentText(b.content));
            if (mm) id = mm[1];
          }
          if (id !== undefined) {
            st.tasks.set(String(id), { id: String(id), ...pending });
            st.timer.observe([...st.tasks.values()], ts);
          }
          st.pendingCreates.delete(b.tool_use_id);
        }
        const done = st.open.get(b.tool_use_id);
        if (done) done.endedAt = ts;
        st.open.delete(b.tool_use_id);
      }
      st.phase = st.open.size > 0 ? 'tool' : 'working';
      st.phaseAt = ts;
      return;
    }

    if (o.isMeta) return;
    const raw = contentText(content);
    if (!raw) return;
    if (/^\s*\[Request interrupted by user/.test(raw)) {
      st.phase = 'interrupted';
      st.phaseAt = ts;
      st.open.clear();
      this.endTurn(st, ts, undefined);
      return;
    }
    st.promptAt = ts;
    const isCommand = raw.includes('<command-name>') || raw.includes('<local-command-');
    const text = stripInjectedTags(raw);
    if (!text) return;
    const origin = o.origin?.kind;
    if (!isCommand && (origin === undefined || origin === 'human')) {
      st.firstPrompt ??= firstLine(text, 100);
      st.turns += 1;
      st.turnSteps = 0;
      st.turnStartedAt = ts;
      st.turnOpen = true;
      st.turnEndedBy = undefined;
    }
    if (!isCommand) {
      st.phase = 'working';
      st.phaseAt = ts;
      st.open.clear();
      st.activity = { kind: 'thinking', label: 'Thinking', startedAt: ts };
    }
  }

  private async readSideFiles(st: ClaudeState, ctx: AdapterContext, changed: boolean): Promise<void> {
    const config = this.configDir(ctx);

    // Task list written by the Tasks tools.
    if (changed || st.taskDir === undefined) {
      const dir = path.join(config, 'tasks', st.sessionId);
      const entries = (await listDir(dir)).filter((e) => e.isFile() && e.name.endsWith('.json'));
      if (entries.length === 0) st.taskDir = { sig: '', tasks: [] };
      else {
        const stats = await Promise.all(entries.map((e) => statSafe(path.join(dir, e.name))));
        const sig = entries.map((e, i) => `${e.name}:${stats[i]?.mtimeMs ?? 0}`).join('|');
        if (sig !== st.taskDir?.sig) {
          const tasks: TaskItem[] = [];
          const timed: { task: TaskItem; mtimeMs: number }[] = [];
          for (const [i, e] of entries.entries()) {
            const t = await readJsonSafe<Record<string, any>>(path.join(dir, e.name));
            if (!t || t.status === 'deleted') continue;
            const task: TaskItem = {
              id: String(t.id ?? path.basename(e.name, '.json')),
              title: String(t.subject ?? t.title ?? ''),
              activeTitle: typeof t.activeForm === 'string' ? t.activeForm : undefined,
              status: normStatus(t.status),
            };
            tasks.push(task);
            if (stats[i]) timed.push({ task, mtimeMs: stats[i]!.mtimeMs });
          }
          tasks.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
          st.taskDir = { sig, tasks };
          st.timer.observeFiles(timed);
        }
      }
    }

    // Live state from Kvali's hooks (optional).
    const liveFile = path.join(ctx.liveDir, 'claude-code', `${st.sessionId}.json`);
    const lst = await statSafe(liveFile);
    if (!lst) st.live = undefined;
    else if (lst.mtimeMs !== st.live?.mtimeMs) {
      const live = await readJsonSafe<LiveState>(liveFile);
      st.live = live ? { ...live, mtimeMs: lst.mtimeMs } : undefined;
    }

    // Heartbeat from Kvali's Claude Code plugin (optional): exact liveness from inside the session.
    const pulseFile = path.join(ctx.liveDir, 'claude-code', `${st.sessionId}.mod.json`);
    const pst = await statSafe(pulseFile);
    if (!pst) st.pulse = undefined;
    else if (pst.mtimeMs !== st.pulse?.mtimeMs) {
      const pulse = await readJsonSafe<PulseFile>(pulseFile);
      st.pulse = pulse && typeof pulse.at === 'number' && typeof pulse.phase === 'string' ? { ...pulse, mtimeMs: pst.mtimeMs } : undefined;
    }

    // Subagent transcripts (tokens only), current layout.
    const now = ctx.now();
    if (now - st.lastSubagentScan >= 5_000) {
      st.lastSubagentScan = now;
      const subDir = path.join(st.projectDir, st.sessionId, 'subagents');
      for (const f of await listDir(subDir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(subDir, f.name);
        if (!st.subagents.has(file)) st.subagents.set(file, { tail: new JsonlTail(file), updatedAt: 0 });
      }
    }
    for (const [, sub] of st.subagents) {
      const res = await sub.tail.read((rec) => this.onRecord(st, rec, ctx, true));
      if (res.changed) sub.updatedAt = now;
    }
  }

  /** Older Claude Code versions wrote subagents as top-level agent-*.jsonl files that reference the parent session. */
  private async readLegacyAgents(ctx: AdapterContext): Promise<void> {
    if (this.legacyAgents.size === 0) return;
    const bySession = new Map<string, ClaudeState>();
    for (const e of this.sessions.values()) bySession.set(e.state.sessionId, e.state);
    for (const [, a] of this.legacyAgents) {
      const res = await a.tail.read((rec) => {
        const sid = (rec as any)?.sessionId;
        const parent = typeof sid === 'string' ? bySession.get(sid) : undefined;
        if (parent) this.onRecord(parent, rec, ctx, true);
      });
      if (res.changed) a.updatedAt = ctx.now();
    }
  }

  private resolveTasks(st: ClaudeState): TaskItem[] {
    if (st.taskDir && st.taskDir.tasks.length > 0) return st.taskDir.tasks;
    if (st.tasks.size > 0) {
      return [...st.tasks.values()].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
    }
    return st.todos ?? [];
  }

  private toSession(st: ClaudeState, ctx: AdapterContext): AgentSession | undefined {
    if (!st.startedAt) return undefined;
    const now = ctx.now();
    const tasks = this.resolveTasks(st);
    const prog = progressOf(tasks);
    const allDone = prog.total > 0 && prog.done === prog.total;

    let status: AgentSession['status'];
    let detail: string | undefined;
    switch (st.phase) {
      case 'tool':
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
        status = allDone ? 'done' : 'idle';
    }

    let lastSignal = st.updatedAt;
    const live = st.live;
    if (live?.at && live.at >= st.phaseAt - 1_000) {
      lastSignal = Math.max(lastSignal, live.at);
      const type = live.notificationType;
      const waiting =
        live.event === 'PermissionRequest' ||
        (live.event === 'Notification' &&
          (type ? WAITING_NOTIFICATIONS.has(type) : /permission|needs your|waiting for your input/i.test(live.message ?? '')));
      if (waiting) {
        status = 'waiting';
        detail = live.toolName ? `Needs approval: ${live.toolName}` : live.message ? truncate(live.message, 90) : 'Needs your input';
      } else if (live.event === 'StopFailure') {
        status = 'error';
        detail = live.message ? truncate(live.message, 90) : 'Stopped with an error';
      } else if (live.event === 'Stop' && status === 'working') {
        status = allDone ? 'done' : 'idle';
      } else if (live.event === 'UserPromptSubmit' && status !== 'working') {
        status = 'working';
      } else if (live.event === 'SessionEnd') {
        if (status === 'working') status = 'idle';
        detail = 'Session ended';
      }
    }

    // The plugin's heartbeat is exact: it reports the model's stream and tools as they happen.
    let pulse: AgentSession['pulse'];
    const beat = st.pulse;
    if (beat && beat.at >= st.startedAt && PULSE_ACTIVE.has(beat.phase as PulsePhase)) {
      if (now - beat.at < PULSE_FRESH_MS) {
        pulse = { phase: beat.phase as PulsePhase, since: beat.since, at: beat.at, label: beat.label, detail: beat.detail, lastDataAt: beat.lastDataAt };
        lastSignal = Math.max(lastSignal, beat.at);
        if (beat.phase === 'needs-you') {
          status = 'waiting';
          detail = beat.label ? `Needs you: ${truncate(beat.label, 80)}` : 'Needs your input';
        } else if (status !== 'waiting' && status !== 'error') status = 'working';
      } else if (st.updatedAt <= beat.at + PULSE_FRESH_MS && (status === 'working' || status === 'waiting')) {
        // It was working, and both its heartbeat and its transcript went quiet: closed or frozen.
        pulse = { phase: 'gone', since: beat.at, at: beat.at };
        status = 'stale';
        detail = 'Claude Code stopped responding';
      }
    }

    if (status === 'working') {
      const stale = staleness(lastSignal, ctx);
      if (stale) {
        status = 'stale';
        detail = stale;
      }
    }

    const activeSubagents = [...st.subagents.values()].filter((s) => now - s.updatedAt < 60_000).length;
    const window = /\[1m\]/i.test(st.model ?? '') || st.maxContext > 200_000 ? 1_000_000 : 200_000;
    const ownTitle = st.customTitle || st.aiTitle || st.summary;
    const title = ownTitle || st.firstPrompt || 'Untitled session';

    let activity = status === 'working' ? st.activity : undefined;
    if (status === 'working' && st.phase === 'tool' && st.open.size > 0) activity = [...st.open.values()].pop();

    return {
      key: `claude-code:${st.sessionId}`,
      agent: 'claude-code',
      agentLabel: this.label,
      id: st.sessionId,
      title: truncate(title, 100),
      titleFromPrompt: !ownTitle && !!st.firstPrompt ? true : undefined,
      projectPath: st.launchCwd ? (findGitRoot(st.launchCwd) ?? st.launchCwd) : undefined,
      cwd: st.launchCwd,
      model: st.model,
      agentVersion: st.version,
      status,
      statusDetail: detail,
      startedAt: st.startedAt,
      updatedAt: Math.max(st.updatedAt, live?.at ?? 0),
      tasks,
      activity,
      tokens: { ...st.tokens },
      costUsd: st.pricedAll || st.costUsd > 0 ? st.costUsd : undefined,
      daily: st.daily,
      context: st.context !== undefined ? { used: st.context, window } : undefined,
      activeSubagents: activeSubagents || undefined,
      turns: st.turns,
      turn: st.turnStartedAt !== undefined ? { steps: st.turnSteps, startedAt: st.turnStartedAt } : undefined,
      current: status === 'working' || status === 'waiting' || status === 'stale' ? st.timer.current(tasks) : undefined,
      recent: st.recent.slice(0, 5),
      trouble: status === 'working' || status === 'stale' ? st.trouble : undefined,
      pulse,
      pushedByPlugin: beat?.push === true && beat.at >= st.startedAt ? true : undefined,
      sources: [st.file],
    };
  }
}
