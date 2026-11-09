/**
 * GitHub Copilot adapter: the Copilot CLI (`copilot`), and VS Code's Copilot chats that run on
 * the same agent runtime (VS Code's default for new chats on the desktop).
 *
 * Each session is a folder `<root>/session-state/<id>/`, where `<root>` is `COPILOT_HOME` or
 * `~/.copilot` on every OS:
 *
 * - `events.jsonl`: the session's event log, appended as it happens (about every 100 ms). Lines
 *   are `{type, data, id, timestamp, parentId, agentId?}`; events of subagents carry `agentId`.
 * - `workspace.yaml`: the session's name, working folder and git root.
 * - `inuse.<pid>.lock`: one per process that has the session open.
 * - `session.db`: SQLite with the session's `todos` table.
 *
 * - Status: an open `permission.requested` (no `permission.completed`) or an `ask_user` /
 *   `exit_plan_mode` call is `waiting`; a model turn in progress, open tool calls, or a turn that
 *   asked for tools is `working`; `session.error` is `error`, `abort` is stopped.
 * - Progress: the latest `update_todo` checklist, or the `todos` table, whichever changed last.
 * - Tokens: `session.usage_record` per model call (or `session.shutdown` totals).
 */
import path from 'node:path';
import { JsonlSessionAdapter, staleness, type AdapterContext, type Candidate } from '../adapter.ts';
import type { Activity, AgentSession, DailyUsage, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { emptyTokens, progressOf, totalTokens } from '../model.ts';
import { parseChecklist } from '../util/checklist.ts';
import { findGitRoot, listDir, readTextSafe, statSafe } from '../util/fs.ts';
import { LoopWatch, loopKey } from '../util/loop-watch.ts';
import { ReadOnlyDb } from '../util/sqlite.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { basename, firstLine, summarizeCommand, truncate } from '../util/text.ts';
import { addTaskDone, addWork, dayKey, parseTime } from '../util/time.ts';

interface OpenTool {
  name: string;
  act: Activity;
}

export interface CopilotState {
  file: string;
  dir: string;
  id: string;
  version?: string;
  startedAt?: number;
  updatedAt: number;
  model?: string;
  cwd?: string;
  gitRoot?: string;
  /** From workspace.yaml. */
  name?: string;
  /** Which program created the session (workspace.yaml `client_name`), e.g. VS Code's agent host. */
  client?: string;
  /** A live process that has the session open. */
  pid?: number;
  workspaceMtime: number;
  firstPrompt?: string;
  /** The last of turn_start / turn_end / abort was a turn_start. */
  turnOpen: boolean;
  /** The agent loop goes on: a prompt came in, or the latest assistant message asked for tools. */
  wantsTools: boolean;
  open: Map<string, OpenTool>;
  permissions: Map<string, string>;
  error?: { message: string; at: number };
  stopped: boolean;
  shutdown: boolean;
  taskComplete: boolean;
  tokens: TokenUsage;
  costUsd: number;
  priced: boolean;
  usageRecords: number;
  /** Totals from `session.shutdown`, per process lifetime, when no per-call usage was recorded. */
  shutdownTokens: TokenUsage;
  daily: Record<string, DailyUsage>;
  context?: number;
  tasks: TaskItem[];
  tasksAt: number;
  dbTasks?: { tasks: TaskItem[]; at: number };
  dbMtime: number;
  timer: TaskTimer;
  loops: LoopWatch;
  recent: Activity[];
  turn?: { steps: number; startedAt: number };
  turns: number;
  subagents: Set<string>;
  lastRecordAt?: number;
  /** Whether a process has the session open (from its lock files), and when that was checked. */
  alive?: boolean;
  aliveCheckedAt: number;
}

const SHELLS = new Set(['bash', 'powershell', 'local_shell']);

function toolActivity(name: string, args: Record<string, any>, title: string | undefined, at: number): Activity {
  if (SHELLS.has(name)) return { kind: 'command', label: 'Shell', detail: summarizeCommand(args.command), startedAt: at };
  const file = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined;
  const d = (s?: string) => (s ? truncate(s, 80) : undefined);
  switch (name) {
    case 'view':
      return { kind: 'tool', label: 'Read', detail: d(file), startedAt: at };
    case 'create':
      return { kind: 'tool', label: 'Write', detail: d(file), startedAt: at };
    case 'edit':
    case 'str_replace_editor':
    case 'apply_patch':
      return { kind: 'tool', label: 'Edit', detail: d(file), startedAt: at };
    case 'grep':
    case 'glob':
      return { kind: 'tool', label: 'Search', detail: d(typeof args.pattern === 'string' ? args.pattern : undefined), startedAt: at };
    case 'web_fetch':
      return { kind: 'tool', label: 'Fetch', detail: d(typeof args.url === 'string' ? args.url : undefined), startedAt: at };
    case 'task':
      return { kind: 'subagent', label: 'Subagent', detail: d(typeof args.description === 'string' ? args.description : undefined), startedAt: at };
    case 'update_todo':
      return { kind: 'tool', label: 'Update plan', startedAt: at };
    case 'ask_user':
      return { kind: 'tool', label: 'Question', startedAt: at };
    case 'exit_plan_mode':
      return { kind: 'tool', label: 'Plan', startedAt: at };
    case 'read_bash':
    case 'write_bash':
    case 'stop_bash':
    case 'list_bash':
      return { kind: 'command', label: 'Shell', detail: 'background command', startedAt: at };
    default:
      return { kind: 'tool', label: title || name, detail: d(file), startedAt: at };
  }
}

function permissionLabel(r: Record<string, any>): string {
  switch (r?.kind) {
    case 'shell':
      return `run ${summarizeCommand(r.fullCommandText, 60) ?? 'a command'}`;
    case 'write':
      return typeof r.fileName === 'string' ? `edit ${basename(r.fileName)}` : 'edit a file';
    case 'read':
      return typeof r.path === 'string' ? `read ${basename(r.path)}` : 'read a file';
    case 'url': {
      try {
        return `fetch ${new URL(String(r.url)).host}`;
      } catch {
        return 'fetch a page';
      }
    }
    case 'mcp':
      return `${r.serverName ?? 'MCP'}: ${r.toolTitle ?? r.toolName ?? 'tool'}`;
    case 'custom-tool':
      return String(r.toolName ?? 'a tool');
    default:
      return typeof r?.kind === 'string' ? r.kind : 'a tool';
  }
}

/** Copilot's checklist markers: `[ ]` pending, `[x]` done, `[-]`/`[~]`/`[/]` in progress. */
function todoMarkdown(md: string): TaskItem[] {
  // Kvali's checklist parser reads `-`/`~` as cancelled; Copilot means "in progress".
  return parseChecklist(md.replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*)\[[-~]\]/gm, '$1[/]')).tasks;
}

function dbStatus(s: unknown): TaskStatus {
  return s === 'done' ? 'completed' : s === 'in_progress' ? 'in_progress' : s === 'blocked' ? 'blocked' : 'pending';
}

function createState(file: string): CopilotState {
  const dir = path.dirname(file);
  const daily: Record<string, DailyUsage> = {};
  return {
    file,
    dir,
    id: path.basename(dir),
    updatedAt: 0,
    workspaceMtime: -1,
    turnOpen: false,
    wantsTools: false,
    open: new Map(),
    permissions: new Map(),
    stopped: false,
    shutdown: false,
    taskComplete: false,
    tokens: emptyTokens(),
    costUsd: 0,
    priced: false,
    usageRecords: 0,
    shutdownTokens: emptyTokens(),
    daily,
    tasks: [],
    tasksAt: 0,
    dbMtime: -1,
    timer: new TaskTimer((at) => addTaskDone(daily, at)),
    loops: new LoopWatch(),
    recent: [],
    turns: 0,
    subagents: new Set(),
    aliveCheckedAt: 0,
  };
}

/** Folds one event into the state. `pricing` estimates cost at API prices. */
export function applyCopilotEvent(st: CopilotState, rec: unknown, price: (model: string | undefined, u: TokenUsage) => number | undefined): void {
  if (!rec || typeof rec !== 'object') return;
  const r = rec as Record<string, any>;
  const type = r.type;
  if (typeof type !== 'string') return;
  const d: Record<string, any> = r.data && typeof r.data === 'object' ? r.data : {};
  const at = parseTime(r.timestamp) ?? st.updatedAt;
  // Subagents write into the same log; their own steps are not the session's.
  if (r.agentId) return;
  if (at > st.updatedAt) st.updatedAt = at;

  const work = () => {
    addWork(st.daily, st.lastRecordAt, at);
    st.lastRecordAt = Math.max(st.lastRecordAt ?? 0, at);
  };

  switch (type) {
    case 'session.start': {
      st.startedAt = parseTime(d.startTime) ?? at;
      if (typeof d.copilotVersion === 'string') st.version = d.copilotVersion;
      if (typeof d.selectedModel === 'string') st.model = d.selectedModel;
      if (d.context?.cwd) st.cwd = String(d.context.cwd);
      if (d.context?.gitRoot) st.gitRoot = String(d.context.gitRoot);
      return;
    }
    case 'session.resume': {
      st.startedAt ??= at;
      if (typeof d.selectedModel === 'string') st.model = d.selectedModel;
      if (d.context?.cwd) st.cwd = String(d.context.cwd);
      if (d.context?.gitRoot) st.gitRoot = String(d.context.gitRoot);
      st.shutdown = false;
      // A new process: what the last one left open is gone, unless it carries on with it.
      if (!d.continuePendingWork) {
        st.open.clear();
        st.permissions.clear();
        st.turnOpen = false;
        st.wantsTools = false;
      }
      return;
    }
    case 'session.model_change':
      if (typeof d.newModel === 'string') st.model = d.newModel;
      return;
    case 'session.context_changed':
      if (typeof d.cwd === 'string') st.cwd = d.cwd;
      if (typeof d.gitRoot === 'string') st.gitRoot = d.gitRoot;
      return;
    case 'user.message': {
      const text = typeof d.content === 'string' ? d.content.trim() : '';
      if (d.isAutopilotContinuation || (typeof d.source === 'string' && d.source !== 'user')) return;
      if (text && !st.firstPrompt && !text.startsWith('/')) st.firstPrompt = firstLine(text, 100);
      st.turn = { steps: 0, startedAt: at };
      st.turns += 1;
      st.loops.reset();
      st.error = undefined;
      st.stopped = false;
      st.taskComplete = false;
      st.wantsTools = true;
      st.lastRecordAt = at;
      return;
    }
    case 'assistant.turn_start':
      st.turnOpen = true;
      st.error = undefined;
      st.stopped = false;
      if (typeof d.model === 'string') st.model = d.model;
      return;
    case 'assistant.message':
      work();
      if (typeof d.model === 'string') st.model = d.model;
      st.wantsTools = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
      return;
    case 'assistant.turn_end':
      work();
      st.turnOpen = false;
      return;
    case 'tool.execution_start': {
      const id = String(d.toolCallId ?? '');
      const name = String(d.toolName ?? 'tool');
      const args = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
      const act = toolActivity(name, args, typeof d.toolTitle === 'string' ? d.toolTitle : undefined, at);
      st.open.set(id, { name, act });
      if (st.turn) st.turn.steps += 1;
      st.timer.step();
      if (st.recent[0]) st.recent[0].endedAt ??= at;
      st.recent.unshift(act);
      if (st.recent.length > 6) st.recent.length = 6;
      if (name === 'update_todo' && typeof args.todos === 'string') {
        st.tasks = todoMarkdown(args.todos);
        st.tasksAt = at;
        st.timer.observe(st.tasks, at);
      }
      return;
    }
    case 'tool.execution_complete': {
      work();
      const id = String(d.toolCallId ?? '');
      const open = st.open.get(id);
      st.open.delete(id);
      if (!open) return;
      open.act.endedAt = at;
      const contents: any[] = Array.isArray(d.result?.contents) ? d.result.contents : [];
      const exit = typeof d.shellExecution?.exitCode === 'number' ? d.shellExecution.exitCode : contents.find((c) => c?.type === 'shell_exit' || c?.type === 'terminal')?.exitCode;
      const text = typeof d.result?.content === 'string' ? d.result.content.slice(-600) : '';
      let failure: string | undefined;
      if (d.success === false) failure = String(d.error?.message ?? d.error?.code ?? 'Tool error');
      else if (SHELLS.has(open.name) && typeof exit === 'number' && exit !== 0) failure = `Exit code ${exit}\n${text}`;
      st.loops.observe(loopKey(open.act), open.act, failure, at, totalTokens(st.tokens));
      return;
    }
    case 'permission.requested':
      if (!d.resolvedByHook && d.requestId) st.permissions.set(String(d.requestId), permissionLabel(d.permissionRequest ?? {}));
      return;
    case 'permission.completed':
      if (d.requestId) st.permissions.delete(String(d.requestId));
      return;
    case 'session.error':
      st.error = { message: firstLine(String(d.message ?? d.errorType ?? 'Error'), 140), at };
      st.turnOpen = false;
      st.wantsTools = false;
      return;
    case 'abort':
      st.stopped = true;
      st.turnOpen = false;
      st.wantsTools = false;
      st.open.clear();
      st.permissions.clear();
      return;
    case 'session.task_complete':
      if (d.success !== false) st.taskComplete = true;
      return;
    case 'subagent.started':
      if (d.toolCallId) st.subagents.add(String(d.toolCallId));
      return;
    case 'subagent.completed':
    case 'subagent.failed':
      if (d.toolCallId) st.subagents.delete(String(d.toolCallId));
      return;
    case 'session.usage_record': {
      const u = d.usage;
      if (!u || typeof u !== 'object') return;
      work();
      st.usageRecords += 1;
      const cacheRead = Number(u.cacheReadTokens) || 0;
      const cacheWrite = Number(u.cacheWriteTokens) || 0;
      const inTok = Number(u.inputTokens) || 0;
      const reasoning = Number(u.reasoningTokens) || 0;
      // The prompt count includes the cached part (as OpenAI-style APIs report it).
      const input = inTok >= cacheRead + cacheWrite ? inTok - cacheRead - cacheWrite : inTok;
      const usage: TokenUsage = { input, output: Number(u.outputTokens) || 0, cacheRead, cacheWrite, reasoning };
      st.tokens.input += usage.input;
      st.tokens.output += usage.output;
      st.tokens.cacheRead += cacheRead;
      st.tokens.cacheWrite += cacheWrite;
      st.tokens.reasoning = (st.tokens.reasoning ?? 0) + reasoning;
      const model = typeof u.model === 'string' ? u.model : st.model;
      const cost = price(model, usage);
      if (cost !== undefined) {
        st.priced = true;
        st.costUsd += cost;
      }
      const b = (st.daily[dayKey(at)] ??= { tokens: 0, costUsd: 0 });
      b.tokens += totalTokens(usage);
      b.costUsd += cost ?? 0;
      if (!u.parentToolCallId) st.context = inTok >= cacheRead + cacheWrite ? inTok : inTok + cacheRead + cacheWrite;
      return;
    }
    case 'session.shutdown': {
      st.shutdown = true;
      st.turnOpen = false;
      st.wantsTools = false;
      st.open.clear();
      st.permissions.clear();
      for (const m of Object.values(d.modelMetrics ?? {}) as any[]) {
        const u = m?.usage;
        if (!u) continue;
        const cacheRead = Number(u.cacheReadTokens) || 0;
        const cacheWrite = Number(u.cacheWriteTokens) || 0;
        const inTok = Number(u.inputTokens) || 0;
        st.shutdownTokens.input += inTok >= cacheRead + cacheWrite ? inTok - cacheRead - cacheWrite : inTok;
        st.shutdownTokens.output += Number(u.outputTokens) || 0;
        st.shutdownTokens.cacheRead += cacheRead;
        st.shutdownTokens.cacheWrite += cacheWrite;
        st.shutdownTokens.reasoning = (st.shutdownTokens.reasoning ?? 0) + (Number(u.reasoningTokens) || 0);
      }
      return;
    }
    default:
      return;
  }
}

/** The few top-level `key: value` lines of workspace.yaml that Kvali reads. */
export function parseWorkspaceYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*?)\s*$/.exec(line);
    if (!m || !m[2] || m[2] === '|' || m[2] === '>') continue;
    let v = m[2];
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    } else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    if (v === 'null' || v === '~') continue;
    out[m[1]] = v;
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class CopilotAdapter extends JsonlSessionAdapter<CopilotState> {
  readonly id = 'copilot';
  readonly label = 'Copilot';

  private root(ctx: AdapterContext): string {
    return ctx.env.COPILOT_HOME || path.join(ctx.home, '.copilot');
  }

  protected async discover(ctx: AdapterContext): Promise<Candidate[]> {
    const dir = path.join(this.root(ctx), 'session-state');
    const out: Candidate[] = [];
    for (const e of await listDir(dir)) {
      if (!e.isDirectory()) continue;
      const file = path.join(dir, e.name, 'events.jsonl');
      const st = await statSafe(file);
      if (st) out.push({ path: file, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  protected createState(file: string): CopilotState {
    return createState(file);
  }

  protected onRecord(st: CopilotState, record: unknown, ctx: AdapterContext): void {
    applyCopilotEvent(st, record, (model, u) =>
      ctx.pricing.cost(model, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite5m: u.cacheWrite, cacheWrite1h: 0 }),
    );
  }

  protected override async afterRead(st: CopilotState, ctx: AdapterContext): Promise<void> {
    const now = ctx.now();
    const ws = path.join(st.dir, 'workspace.yaml');
    const wst = await statSafe(ws);
    if (wst && wst.mtimeMs !== st.workspaceMtime) {
      st.workspaceMtime = wst.mtimeMs;
      const y = parseWorkspaceYaml((await readTextSafe(ws, 256 << 10)) ?? '');
      if (y.name) st.name = y.name;
      if (y.client_name) st.client = y.client_name;
      if (y.cwd) st.cwd ??= y.cwd;
      if (y.git_root) st.gitRoot ??= y.git_root;
    }
    // Which processes have the session open; a lock whose process is gone was left by a crash.
    if (now - st.aliveCheckedAt >= 5_000) {
      st.aliveCheckedAt = now;
      const locks = (await listDir(st.dir)).map((e) => /^inuse\.(\d+)\.lock$/.exec(e.name)).filter((m): m is RegExpExecArray => !!m);
      const live = locks.map((m) => Number(m[1])).filter((pid) => pidAlive(pid));
      st.alive = locks.length ? live.length > 0 : undefined;
      st.pid = live[0];
    }
    // The session's todo table, when the agent keeps its plan there.
    const dbFile = path.join(st.dir, 'session.db');
    const dbm = Math.max((await statSafe(dbFile))?.mtimeMs ?? 0, (await statSafe(`${dbFile}-wal`))?.mtimeMs ?? 0);
    if (dbm && dbm !== st.dbMtime) {
      st.dbMtime = dbm;
      const db = ReadOnlyDb.open(dbFile);
      if (db) {
        try {
          const rows = db.all('SELECT id, title, status FROM todos ORDER BY created_at, rowid');
          st.dbTasks = rows.length
            ? { tasks: rows.map((r, i) => ({ id: String(r.id ?? i + 1), title: String(r.title ?? ''), status: dbStatus(r.status) })), at: Math.min(dbm, now) }
            : undefined;
          if (st.dbTasks && st.dbTasks.at >= st.tasksAt) st.timer.observe(st.dbTasks.tasks, st.dbTasks.at);
        } finally {
          db.close();
        }
      }
    }
  }

  protected toSession(st: CopilotState, ctx: AdapterContext): AgentSession | undefined {
    if (!st.startedAt && !st.firstPrompt) return undefined;
    const now = ctx.now();
    const tasks = st.dbTasks && st.dbTasks.at >= st.tasksAt ? st.dbTasks.tasks : st.tasks;
    const prog = progressOf(tasks);
    const closed = st.shutdown || st.alive === false;
    let status: AgentSession['status'];
    let detail: string | undefined;
    let activity: Activity | undefined;
    const open = [...st.open.values()];
    const asking = open.find((t) => t.name === 'ask_user' || t.name === 'exit_plan_mode');
    if (st.error) {
      status = 'error';
      detail = st.error.message;
    } else if (st.stopped) {
      status = 'idle';
      detail = 'Stopped';
    } else if (closed) {
      status = st.taskComplete || (prog.total > 0 && prog.done === prog.total) ? 'done' : 'idle';
      if (st.alive === false && !st.shutdown && (st.turnOpen || open.length)) detail = 'Copilot was closed';
    } else if (st.permissions.size) {
      status = 'waiting';
      detail = `Needs approval: ${[...st.permissions.values()].pop()}`;
      activity = open[open.length - 1]?.act;
    } else if (asking) {
      status = 'waiting';
      detail = asking.name === 'exit_plan_mode' ? 'Plan ready for your review' : 'Asked you a question';
      activity = asking.act;
    } else if (st.turnOpen || open.length || st.wantsTools) {
      status = 'working';
      activity = open[open.length - 1]?.act ?? { kind: 'thinking', label: 'Thinking', startedAt: st.updatedAt };
      const stale = staleness(st.updatedAt, ctx);
      if (stale) {
        status = 'stale';
        detail = stale;
        activity = undefined;
      }
    } else {
      status = st.taskComplete || (prog.total > 0 && prog.done === prog.total) ? 'done' : 'idle';
    }
    const tokens = st.usageRecords ? { ...st.tokens } : totalTokens(st.shutdownTokens) ? { ...st.shutdownTokens } : undefined;
    const loop = status === 'working' || status === 'stale' ? st.loops.current(now) : undefined;
    const root = st.gitRoot || (st.cwd ? findGitRoot(st.cwd) : undefined) || st.cwd;
    const title = st.name || st.firstPrompt;
    return {
      key: `copilot:${st.id}`,
      agent: 'copilot',
      agentLabel: this.label,
      id: st.id,
      title: title ?? 'Untitled session',
      titleFromPrompt: !st.name && st.firstPrompt ? true : undefined,
      projectPath: root,
      cwd: st.cwd,
      model: st.model,
      agentVersion: st.version,
      host: st.client && /vscode|ide/i.test(st.client) ? 'editor' : 'terminal',
      pid: st.pid,
      status,
      statusDetail: detail,
      startedAt: st.startedAt ?? st.updatedAt,
      updatedAt: st.updatedAt,
      tasks,
      activity,
      turn: st.turn,
      turns: st.turns,
      current: status === 'working' || status === 'stale' ? st.timer.current(tasks) : undefined,
      recent: st.recent.slice(0, 5),
      loop: loop
        ? {
            label: loop.label,
            detail: loop.detail,
            count: loop.count,
            sameError: loop.sameError,
            since: loop.since,
            tokens: loop.tokensAtStart !== undefined ? totalTokens(st.tokens) - loop.tokensAtStart : undefined,
          }
        : undefined,
      tokens,
      costUsd: st.priced ? st.costUsd : undefined,
      daily: st.daily,
      context: st.context ? { used: st.context } : undefined,
      activeSubagents: status === 'working' && st.subagents.size ? st.subagents.size : undefined,
      sources: [st.file],
    };
  }
}
