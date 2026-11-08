/**
 * OpenCode and Kilo Code adapters.
 *
 * Both keep every session in one SQLite database (Kilo Code is built on OpenCode):
 *   OpenCode   (XDG_DATA_HOME or ~/.local/share)/opencode/opencode.db   (`OPENCODE_DB` overrides)
 *   Kilo Code  (XDG_DATA_HOME or ~/.local/share)/kilo/kilo.db           (`KILO_DB` overrides)
 * on every OS. Two layouts exist:
 *
 * - OpenCode 2.x: `session_v2` (status times: `time_busy`, `time_idle`, `idle_outcome`; totals),
 *   `session_message` (one row per user prompt, model step and `idle` marker, JSON in `data`) and
 *   `session_part` (content items stored apart from their message).
 * - OpenCode 1.x and Kilo Code: `session`, `message` and `part` with JSON in `data`, and `todo`.
 *
 * The database is opened read-only through the runtime's `node:sqlite` (see util/sqlite.ts) and
 * only the rows that changed since the last poll are read. A pending permission prompt is not
 * written to the database; for OpenCode 2.x Kvali asks the local OpenCode service (found in
 * `$XDG_STATE_HOME/opencode/service.json`) which prompts are open, with a read-only request.
 */
import path from 'node:path';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { staleness } from '../adapter.ts';
import type { Activity, AgentId, AgentSession, DailyUsage, SessionStatus, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { emptyTokens, progressOf, totalTokens } from '../model.ts';
import type { Pricing } from '../pricing.ts';
import { findGitRoot, readJsonSafe, statSafe } from '../util/fs.ts';
import { LoopWatch, loopKey } from '../util/loop-watch.ts';
import { ReadOnlyDb, type Row, sqliteModule } from '../util/sqlite.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { contentText, firstLine, summarizeCommand, truncate } from '../util/text.ts';
import { addTaskDone, addWork, dayKey } from '../util/time.ts';

type Layout = 'v2' | 'v1';

/** One tool call, as much of it as Kvali needs. */
export interface ToolSummary {
  name: string;
  status: string;
  created: number;
  completed?: number;
  act: Activity;
  /** Why it failed: an error, or a command that exited non-zero or timed out. */
  failure?: string;
  /** A `todowrite` call's list. */
  todos?: TaskItem[];
}

/** One message (OpenCode 2.x: one row of `session_message`). */
export interface MessageSummary {
  id: string;
  /** Sort key: the row's sequence (2.x) or creation time (1.x). */
  order: number;
  type: string;
  created: number;
  completed?: number;
  text?: string;
  model?: string;
  tokens?: TokenUsage;
  cost?: number;
  error?: { type?: string; message: string };
  outcome?: string;
  retry?: { attempt?: number; message: string; at: number };
  tools: ToolSummary[];
  synthetic?: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

function parseData(v: unknown): Record<string, any> | undefined {
  if (v && typeof v === 'object') return v as Record<string, any>;
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : undefined;
  } catch {
    return undefined;
  }
}

/** OpenCode's token record → Kvali's (output includes reasoning). */
function tokensOf(t: any): TokenUsage | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const reasoning = num(t.reasoning);
  return { input: num(t.input), output: num(t.output) + reasoning, cacheRead: num(t.cache?.read), cacheWrite: num(t.cache?.write), reasoning };
}

function todoStatus(s: unknown): TaskStatus {
  switch (s) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function todosOf(list: unknown): TaskItem[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .map((t, i) => ({ id: typeof t.id === 'string' ? t.id : String(i + 1), title: t.content.trim(), status: todoStatus(t.status) }));
}

const SHELL_TOOLS = new Set(['shell', 'bash']);

/** What a tool call does, in Kvali's words. */
function toolAct(name: string, input: Record<string, any>, at: number): Activity {
  if (SHELL_TOOLS.has(name)) return { kind: 'command', label: 'Shell', detail: summarizeCommand(input.command), startedAt: at };
  const file = typeof input.filePath === 'string' ? input.filePath : typeof input.path === 'string' ? input.path : undefined;
  const short = (p?: string) => (p ? truncate(p, 80) : undefined);
  switch (name) {
    case 'read':
      return { kind: 'tool', label: 'Read', detail: short(file), startedAt: at };
    case 'write':
      return { kind: 'tool', label: 'Write', detail: short(file), startedAt: at };
    case 'edit':
    case 'multiedit':
    case 'patch':
    case 'apply_patch':
      return { kind: 'tool', label: 'Edit', detail: short(file), startedAt: at };
    case 'grep':
    case 'glob':
    case 'codesearch':
      return { kind: 'tool', label: 'Search', detail: short(typeof input.pattern === 'string' ? input.pattern : typeof input.query === 'string' ? input.query : undefined), startedAt: at };
    case 'list':
      return { kind: 'tool', label: 'List files', detail: short(file), startedAt: at };
    case 'webfetch':
      return { kind: 'tool', label: 'Fetch', detail: short(typeof input.url === 'string' ? input.url : undefined), startedAt: at };
    case 'websearch':
      return { kind: 'tool', label: 'Web search', detail: short(typeof input.query === 'string' ? input.query : undefined), startedAt: at };
    case 'task':
    case 'subagent':
      return { kind: 'subagent', label: 'Subagent', detail: short(typeof input.description === 'string' ? input.description : undefined), startedAt: at };
    case 'todowrite':
      return { kind: 'tool', label: 'Update plan', startedAt: at };
    case 'question':
      return { kind: 'tool', label: 'Question', startedAt: at };
    default:
      return { kind: 'tool', label: name, detail: short(file), startedAt: at };
  }
}

/** Why a finished tool call failed, if it did: OpenCode records a non-zero exit as `completed`. */
function failureOf(name: string, state: Record<string, any>, contentText2: () => string): string | undefined {
  if (state.status === 'error') {
    const e = state.error;
    return typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : 'Tool error';
  }
  if (state.status !== 'completed' || !SHELL_TOOLS.has(name)) return undefined;
  const m = state.metadata ?? {};
  if (m.timeout === true) return `Timed out\n${contentText2()}`;
  if (typeof m.exit === 'number' && m.exit !== 0) return `Exit code ${m.exit}\n${contentText2()}`;
  return undefined;
}

/** An OpenCode 2.x content item (from `data.content` or a `session_part` row). */
export function summarizeV2Tool(item: Record<string, any>): ToolSummary | undefined {
  if (item?.type !== 'tool' || typeof item.name !== 'string') return undefined;
  const state = item.state && typeof item.state === 'object' ? item.state : {};
  const created = num(item.time?.created);
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const text = () => (Array.isArray(state.content) ? contentText(state.content.filter((c: any) => c?.type === 'text')).slice(-600) : '');
  return {
    name: item.name,
    status: String(state.status ?? 'running'),
    created,
    completed: item.time?.completed !== undefined ? num(item.time.completed) : undefined,
    act: toolAct(item.name, input, created),
    failure: failureOf(item.name, state, text),
    todos: item.name === 'todowrite' && state.status === 'completed' ? todosOf(input.todos) : undefined,
  };
}

/** An OpenCode 1.x / Kilo Code tool part. */
export function summarizeV1Tool(part: Record<string, any>): ToolSummary | undefined {
  if (part?.type !== 'tool' || typeof part.tool !== 'string') return undefined;
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const created = num(state.time?.start);
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const text = () => (typeof state.output === 'string' ? state.output.slice(-600) : '');
  return {
    name: part.tool,
    status: String(state.status ?? 'pending'),
    created,
    completed: state.time?.end !== undefined ? num(state.time.end) : undefined,
    act: toolAct(part.tool, input, created),
    failure: failureOf(part.tool, state, text),
    todos: part.tool === 'todowrite' && state.status === 'completed' ? todosOf(input.todos) : undefined,
  };
}

/** An OpenCode 2.x `session_message` row. */
export function summarizeV2Message(row: { id: string; type: string; seq?: unknown; time_created?: unknown; data: unknown }): MessageSummary {
  const d = parseData(row.data) ?? {};
  const created = num(d.time?.created) || num(row.time_created);
  const s: MessageSummary = { id: row.id, order: num(row.seq) || created, type: row.type, created, tools: [] };
  switch (row.type) {
    case 'user':
      if (typeof d.text === 'string') s.text = d.text;
      break;
    case 'assistant':
    case 'compaction': {
      s.model = typeof d.model?.id === 'string' ? d.model.id : undefined;
      s.tokens = tokensOf(d.tokens);
      s.cost = typeof d.cost === 'number' ? d.cost : undefined;
      if (d.time?.completed !== undefined) s.completed = num(d.time.completed);
      if (d.error && typeof d.error === 'object') s.error = { type: d.error.type, message: String(d.error.message ?? d.error.type ?? 'Error') };
      if (d.retry && typeof d.retry === 'object') s.retry = { attempt: num(d.retry.attempt) || undefined, message: String(d.retry.error?.message ?? 'Retrying'), at: num(d.retry.at) };
      if (row.type === 'compaction') s.completed = d.status === 'running' ? undefined : created;
      for (const item of Array.isArray(d.content) ? d.content : []) {
        const t = summarizeV2Tool(item);
        if (t) s.tools.push(t);
      }
      break;
    }
    case 'idle':
      s.outcome = typeof d.outcome === 'string' ? d.outcome : undefined;
      if (d.error && typeof d.error === 'object') s.error = { type: d.error.type, message: String(d.error.message ?? 'Error') };
      break;
    case 'synthetic':
      s.synthetic = true;
      break;
    default:
      break;
  }
  return s;
}

/** An OpenCode 1.x / Kilo Code `message` row. */
export function summarizeV1Message(row: { id: string; time_created?: unknown; data: unknown }): MessageSummary {
  const d = parseData(row.data) ?? {};
  const created = num(d.time?.created) || num(row.time_created);
  const s: MessageSummary = { id: row.id, order: created, type: d.role === 'assistant' ? 'assistant' : 'user', created, tools: [] };
  if (d.role === 'assistant') {
    s.model = typeof d.modelID === 'string' ? d.modelID : undefined;
    s.tokens = tokensOf(d.tokens);
    s.cost = typeof d.cost === 'number' ? d.cost : undefined;
    if (d.time?.completed !== undefined) s.completed = num(d.time.completed);
    if (d.error && typeof d.error === 'object') {
      s.error = { type: d.error.name, message: String(d.error.data?.message ?? d.error.message ?? d.error.name ?? 'Error') };
    }
  }
  return s;
}

/** A part of a message other than a tool call, as far as Kvali cares (1.x). */
interface PartSummary {
  messageId: string;
  /** Order within the message. */
  order: number | string;
  tool?: ToolSummary;
  /** A user message's text (1.x keeps it in parts). */
  text?: string;
  synthetic?: boolean;
  retry?: { attempt?: number; message: string; at: number };
}

/** What the whole session says, folded from the summaries. */
export interface OpenCodeFold {
  title?: string;
  model?: string;
  startedAt?: number;
  lastAt: number;
  tokens: TokenUsage;
  costUsd: number;
  priced: boolean;
  daily: Record<string, DailyUsage>;
  context?: number;
  tasks: TaskItem[];
  timer: TaskTimer;
  recent: Activity[];
  turn?: { steps: number; startedAt: number };
  turns: number;
  loops: LoopWatch;
  /** The open tool calls of the step in progress. */
  open: ToolSummary[];
  /** The last step: whether it is done and how it ended. */
  last?: MessageSummary;
  /** The last turn's end marker (2.x). */
  lastIdle?: MessageSummary;
  /** A prompt or a step after the last end marker: a turn in progress (2.x). */
  afterIdle: boolean;
}

/** Folds a session's messages, in order, with each message's tool calls. */
export function foldOpenCode(messages: readonly MessageSummary[], pricing: Pricing, explicitTodos?: { tasks: TaskItem[]; at: number }): OpenCodeFold {
  const daily: Record<string, DailyUsage> = {};
  const f: OpenCodeFold = {
    lastAt: 0,
    tokens: emptyTokens(),
    costUsd: 0,
    priced: false,
    daily,
    tasks: [],
    timer: new TaskTimer((at) => addTaskDone(daily, at)),
    recent: [],
    turns: 0,
    loops: new LoopWatch(),
    open: [],
    afterIdle: false,
  };
  let prevAt: number | undefined;
  let steps = 0;
  let turnStart: number | undefined;
  for (const m of messages) {
    if (m.created) {
      if (f.startedAt === undefined || m.created < f.startedAt) f.startedAt = m.created;
      f.lastAt = Math.max(f.lastAt, m.created, m.completed ?? 0);
    }
    if (m.type === 'user' && !m.synthetic) {
      const text = m.text?.trim();
      if (text && !f.title) f.title = firstLine(text, 100);
      turnStart = m.created;
      steps = 0;
      f.turns += 1;
      f.loops.reset();
      prevAt = m.created;
      f.afterIdle = true;
      continue;
    }
    if (m.type === 'idle') {
      f.lastIdle = m;
      f.afterIdle = false;
      continue;
    }
    if (m.type !== 'assistant' && m.type !== 'compaction') continue;
    f.afterIdle = true;
    f.last = m;
    if (m.model) f.model = m.model;
    if (m.tokens) {
      const u = m.tokens;
      f.tokens.input += u.input;
      f.tokens.output += u.output;
      f.tokens.cacheRead += u.cacheRead;
      f.tokens.cacheWrite += u.cacheWrite;
      f.tokens.reasoning = (f.tokens.reasoning ?? 0) + (u.reasoning ?? 0);
      // OpenCode prices every model it knows; a subscription reports 0, which Kvali estimates at API prices.
      let cost = m.cost;
      if (!cost) {
        const est = pricing.cost(m.model ?? f.model, { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite5m: u.cacheWrite, cacheWrite1h: 0 });
        if (est !== undefined) cost = est;
      }
      if (cost !== undefined) f.priced = true;
      f.costUsd += cost ?? 0;
      const b = (daily[dayKey(m.created || Date.now())] ??= { tokens: 0, costUsd: 0 });
      b.tokens += totalTokens(u);
      b.costUsd += cost ?? 0;
      if (m.type === 'assistant' && u.input + u.cacheRead + u.cacheWrite > 0) f.context = u.input + u.cacheRead + u.cacheWrite;
    }
    const end = m.completed ?? Math.max(m.created, ...m.tools.map((t) => t.completed ?? t.created));
    if (end) {
      addWork(daily, prevAt, end);
      prevAt = Math.max(prevAt ?? 0, end);
    }
    for (const t of m.tools) {
      steps += 1;
      f.timer.step();
      if (f.recent[0]) f.recent[0].endedAt ??= t.created || undefined;
      f.recent.unshift({ ...t.act, endedAt: t.completed });
      if (f.recent.length > 6) f.recent.length = 6;
      if (t.status === 'completed' || t.status === 'error') f.loops.observe(loopKey(t.act), t.act, t.failure, t.completed ?? t.created, totalTokens(f.tokens));
      if (t.todos && !explicitTodos) {
        f.tasks = t.todos;
        f.timer.observe(t.todos, t.completed ?? t.created);
      }
    }
  }
  if (explicitTodos) {
    f.tasks = explicitTodos.tasks;
    f.timer.observe(explicitTodos.tasks, explicitTodos.at);
  }
  if (f.last && f.last.completed === undefined && !f.last.error) f.open = f.last.tools.filter((t) => t.status === 'running' || t.status === 'streaming' || t.status === 'pending');
  if (turnStart !== undefined) f.turn = { steps, startedAt: turnStart };
  return f;
}

/** What the session's row says about its status (2.x), or undefined when the row cannot tell. */
function rowBusy(row: Row): boolean | undefined {
  if (!('time_busy' in row)) return undefined;
  const busy = row.time_busy == null ? undefined : num(row.time_busy);
  const idle = row.time_idle == null ? undefined : num(row.time_idle);
  if (busy === undefined) return false;
  return idle === undefined || busy > idle;
}

export interface LiveWait {
  /** A permission prompt is open: what it asks for. */
  permission?: string;
  /** A question waits for an answer. */
  question?: boolean;
}

/** The session's status at `now`. */
export function openCodeStatus(
  f: OpenCodeFold,
  row: Row,
  layout: Layout,
  label: string,
  live: LiveWait | undefined,
): { status: SessionStatus; detail?: string; activity?: Activity; trouble?: AgentSession['trouble'] } {
  const last = f.last;
  const busy = isBusy(f, row, layout);
  const prog = progressOf(f.tasks);
  if (busy) {
    if (live?.permission) return { status: 'waiting', detail: `Needs approval: ${live.permission}`, activity: f.open[f.open.length - 1]?.act };
    const question = f.open.find((t) => t.name === 'question');
    if (live?.question || question) return { status: 'waiting', detail: 'Asked you a question', activity: question?.act };
    const activity = f.open[f.open.length - 1]?.act ?? (last && last.completed === undefined ? { kind: 'thinking' as const, label: 'Thinking', startedAt: last.created } : undefined);
    const retry = last && last.completed === undefined ? last.retry : undefined;
    return { status: 'working', activity, trouble: retry ? { message: firstLine(retry.message, 120), at: retry.at || last!.created, attempt: retry.attempt } : undefined };
  }
  const finished = { status: prog.total > 0 && prog.done === prog.total ? ('done' as const) : ('idle' as const) };
  const outcome = layout === 'v2' ? (typeof row.idle_outcome === 'string' ? row.idle_outcome : f.lastIdle?.outcome) : undefined;
  if (outcome === 'failed') return { status: 'error', detail: firstLine(f.lastIdle?.error?.message ?? last?.error?.message ?? 'The turn failed', 140) };
  if (outcome === 'interrupted') return { status: 'idle', detail: 'Stopped' };
  if (outcome === 'succeeded') return finished;
  if (last?.error) {
    const aborted = last.error.type === 'MessageAbortedError' || last.error.type === 'aborted';
    if (aborted) return { status: 'idle', detail: 'Stopped' };
    return { status: 'error', detail: firstLine(last.error.message, 140) };
  }
  return finished;
}

/** Whether a turn is in progress. */
function isBusy(f: OpenCodeFold, row: Row, layout: Layout): boolean {
  if (layout === 'v2') {
    // 2.2 records it on the session; before, a turn runs until its `idle` marker.
    return rowBusy(row) ?? f.afterIdle;
  }
  // 1.x: the last step is unfinished, or a prompt still waits for its first step.
  if (f.last && f.last.completed === undefined && !f.last.error) return true;
  return f.turn !== undefined && (!f.last || f.last.created < f.turn.startedAt);
}

interface Cached {
  id: string;
  row: Row;
  rowUpdated: number;
  msgs: Map<string, MessageSummary>;
  parts: Map<string, PartSummary>;
  maxMsgUpdated: number;
  maxPartUpdated: number;
  todos?: { tasks: TaskItem[]; at: number };
  todoSig?: string;
  fold?: OpenCodeFold;
  lastFull: number;
}

/** Rows written within this long before the newest one seen are read again: clocks and same-millisecond writes. */
const SLACK_MS = 2_000;
const FULL_RELOAD_MS = 60_000;

export interface OpenCodeFamilyOptions {
  /** Read the database at this path instead of the default (tests). */
  dbFile?: string;
}

abstract class OpenCodeFamilyAdapter implements Adapter {
  abstract readonly id: AgentId;
  abstract readonly label: string;
  /** The folder under XDG data and the database file name. */
  protected abstract readonly app: string;
  protected abstract readonly dbEnv: string;
  /** Ask the agent's local service for open permission prompts (OpenCode 2.x). */
  protected readonly probeService: boolean = false;

  private readonly options: OpenCodeFamilyOptions;
  private db: ReadOnlyDb | undefined;
  private dbFile: string | undefined;
  private layout: Layout | undefined;
  private columns = new Map<string, Set<string>>();
  private lastOpenTry = 0;
  private readonly cache = new Map<string, Cached>();
  private sessions: AgentSession[] = [];
  private lastQuery = 0;
  private busyChildren = new Map<string, number>();
  private warned = false;
  private readonly live = new LiveProbe();

  constructor(options: OpenCodeFamilyOptions = {}) {
    this.options = options;
  }

  dataDir(ctx: AdapterContext): string {
    return path.join(ctx.env.XDG_DATA_HOME || path.join(ctx.home, '.local', 'share'), this.app);
  }

  databaseFile(ctx: AdapterContext): string {
    if (this.options.dbFile) return this.options.dbFile;
    const override = ctx.env[this.dbEnv];
    if (override && override !== ':memory:') return path.isAbsolute(override) ? override : path.join(this.dataDir(ctx), override);
    return path.join(this.dataDir(ctx), `${this.app}.db`);
  }

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (!this.db) {
      if (now - this.lastOpenTry < 30_000 && this.lastOpenTry) return [];
      this.lastOpenTry = now;
      const file = this.databaseFile(ctx);
      if (!(await statSafe(file))) return [];
      if (!sqliteModule()) {
        if (!this.warned) ctx.log(`${this.label}: this runtime has no built-in SQLite (node:sqlite, Node 22.13+), so its sessions cannot be read here.`);
        this.warned = true;
        return [];
      }
      this.db = ReadOnlyDb.open(file);
      this.dbFile = file;
      if (!this.db) return [];
      this.columns = this.db.schema();
      this.layout = this.columns.has('session_v2') && this.columns.has('session_message') ? 'v2' : this.columns.has('session') && this.columns.has('message') ? 'v1' : undefined;
      if (!this.layout) {
        this.dispose();
        return [];
      }
    }
    const db = this.db;
    if (db.changed() || now - this.lastQuery >= 10_000) {
      this.lastQuery = now;
      // A newer version may have added tables or columns.
      if (this.layout === 'v1' && db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'session_v2'")) {
        this.columns = db.schema();
        this.layout = 'v2';
        this.cache.clear();
      }
      this.query(db, ctx);
    }
    this.sessions = [...this.cache.values()].map((c) => this.toSession(c, ctx)).filter((s): s is AgentSession => !!s);
    // Ask about the busy ones now; the answer is used on the next poll.
    if (this.probeService) await this.live.refresh(ctx, this.sessions.filter((s) => s.status === 'working' || s.status === 'waiting').map((s) => s.id));
    return this.sessions;
  }

  dispose(): void {
    this.db?.close();
    this.db = undefined;
    this.cache.clear();
  }

  private sessionTable(): string {
    return this.layout === 'v2' ? 'session_v2' : 'session';
  }

  private query(db: ReadOnlyDb, ctx: AdapterContext): void {
    const now = ctx.now();
    const table = this.sessionTable();
    const have = this.columns.get(table) ?? new Set<string>();
    const wanted = [
      'id', 'parent_id', 'directory', 'title', 'cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read',
      'tokens_cache_write', 'model', 'agent', 'version', 'revert', 'time_created', 'time_updated', 'time_busy', 'time_idle',
      'idle_outcome', 'time_suspended', 'time_archived',
    ].filter((c) => have.has(c));
    if (!have.has('id') || !have.has('time_updated')) return;
    const where = [`time_updated >= ?`, have.has('parent_id') ? 'parent_id IS NULL' : '', have.has('time_archived') ? 'time_archived IS NULL' : ''].filter(Boolean).join(' AND ');
    const rows = db.all(`SELECT ${wanted.join(', ')} FROM ${table} WHERE ${where} ORDER BY time_updated DESC LIMIT ?`, now - ctx.activeWindowMs, ctx.maxSessionsPerAgent);
    const keep = new Set<string>();
    for (const row of rows) {
      const id = String(row.id);
      keep.add(id);
      let c = this.cache.get(id);
      const updated = num(row.time_updated);
      if (!c) {
        c = { id, row, rowUpdated: -1, msgs: new Map(), parts: new Map(), maxMsgUpdated: 0, maxPartUpdated: 0, lastFull: 0 };
        this.cache.set(id, c);
      }
      const wasBusy = c.fold ? openCodeStatus(c.fold, c.row, this.layout!, this.label, undefined).status === 'working' : true;
      const revertChanged = String(c.row.revert ?? '') !== String(row.revert ?? '');
      c.row = row;
      if (updated !== c.rowUpdated || wasBusy || rowBusy(row) || revertChanged) {
        if (revertChanged || now - c.lastFull >= FULL_RELOAD_MS) this.reload(db, c, now);
        else this.readChanges(db, c);
        c.rowUpdated = updated;
        c.fold = undefined;
      }
    }
    for (const id of [...this.cache.keys()]) if (!keep.has(id)) this.cache.delete(id);
    this.busyChildren = this.countBusyChildren(db, now);
  }

  private reload(db: ReadOnlyDb, c: Cached, now: number): void {
    c.msgs.clear();
    c.parts.clear();
    c.maxMsgUpdated = 0;
    c.maxPartUpdated = 0;
    c.lastFull = now;
    this.readChanges(db, c);
  }

  /** Reads the rows of the session written since the last read. */
  private readChanges(db: ReadOnlyDb, c: Cached): void {
    if (this.layout === 'v2') {
      for (const r of db.all('SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? AND time_updated >= ?', c.id, c.maxMsgUpdated - SLACK_MS)) {
        c.msgs.set(String(r.id), summarizeV2Message({ id: String(r.id), type: String(r.type), seq: r.seq, time_created: r.time_created, data: r.data }));
        c.maxMsgUpdated = Math.max(c.maxMsgUpdated, num(r.time_updated));
      }
      if (this.columns.has('session_part')) {
        for (const r of db.all('SELECT message_id, ordinal, time_updated, data FROM session_part WHERE session_id = ? AND time_updated >= ?', c.id, c.maxPartUpdated - SLACK_MS)) {
          const tool = summarizeV2Tool(parseData(r.data) ?? {});
          c.parts.set(`${r.message_id}:${r.ordinal}`, { messageId: String(r.message_id), order: num(r.ordinal), tool });
          c.maxPartUpdated = Math.max(c.maxPartUpdated, num(r.time_updated));
        }
      }
      const n = num(db.get('SELECT count(*) AS n FROM session_message WHERE session_id = ?', c.id)?.n);
      if (n < c.msgs.size) this.reload(db, c, c.lastFull);
      return;
    }
    for (const r of db.all('SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? AND time_updated >= ?', c.id, c.maxMsgUpdated - SLACK_MS)) {
      c.msgs.set(String(r.id), summarizeV1Message({ id: String(r.id), time_created: r.time_created, data: r.data }));
      c.maxMsgUpdated = Math.max(c.maxMsgUpdated, num(r.time_updated));
    }
    for (const r of db.all('SELECT id, message_id, time_updated, data FROM part WHERE session_id = ? AND time_updated >= ?', c.id, c.maxPartUpdated - SLACK_MS)) {
      const d = parseData(r.data) ?? {};
      const p: PartSummary = { messageId: String(r.message_id), order: String(r.id) };
      if (d.type === 'tool') p.tool = summarizeV1Tool(d);
      else if (d.type === 'text' && typeof d.text === 'string') {
        p.text = d.text;
        p.synthetic = d.synthetic === true;
      } else if (d.type === 'retry') p.retry = { attempt: num(d.attempt) || undefined, message: String(d.error?.data?.message ?? d.error?.message ?? 'Retrying'), at: num(d.time?.created) };
      c.parts.set(String(r.id), p);
      c.maxPartUpdated = Math.max(c.maxPartUpdated, num(r.time_updated));
    }
    const n = num(db.get('SELECT count(*) AS n FROM message WHERE session_id = ?', c.id)?.n);
    if (n < c.msgs.size) this.reload(db, c, c.lastFull);
    if (this.columns.has('todo')) {
      const rows = db.all('SELECT content, status, position, time_updated FROM todo WHERE session_id = ? ORDER BY position', c.id);
      const sig = JSON.stringify(rows);
      if (sig !== c.todoSig) {
        c.todoSig = sig;
        c.todos = rows.length
          ? { tasks: todosOf(rows) ?? [], at: Math.max(...rows.map((r) => num(r.time_updated))) }
          : undefined;
      }
    }
  }

  /** Subagent sessions at work, per parent. */
  private countBusyChildren(db: ReadOnlyDb, now: number): Map<string, number> {
    const out = new Map<string, number>();
    const table = this.sessionTable();
    const have = this.columns.get(table) ?? new Set<string>();
    if (!have.has('parent_id')) return out;
    let rows: Row[] = [];
    if (this.layout === 'v2' && have.has('time_busy')) {
      rows = db.all(`SELECT parent_id, count(*) AS n FROM ${table} WHERE parent_id IS NOT NULL AND time_updated >= ? AND time_busy IS NOT NULL AND (time_idle IS NULL OR time_busy > time_idle) GROUP BY parent_id`, now - 3_600_000);
    } else if (this.layout === 'v1') {
      rows = db.all(
        `SELECT s.parent_id AS parent_id, count(*) AS n FROM session s WHERE s.parent_id IS NOT NULL AND s.time_updated >= ? AND EXISTS (
           SELECT 1 FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'assistant'
             AND json_extract(m.data, '$.time.completed') IS NULL AND json_extract(m.data, '$.error') IS NULL) GROUP BY s.parent_id`,
        now - 600_000,
      );
    }
    for (const r of rows) out.set(String(r.parent_id), num(r.n));
    return out;
  }

  /** The session's messages in order, each with its tool calls (parts first, then inline items). */
  private ordered(c: Cached): MessageSummary[] {
    const partsBy = new Map<string, PartSummary[]>();
    for (const p of c.parts.values()) {
      const list = partsBy.get(p.messageId);
      if (list) list.push(p);
      else partsBy.set(p.messageId, [p]);
    }
    const revert = parseData(c.row.revert);
    const cut = typeof revert?.messageID === 'string' ? revert.messageID : undefined;
    const out: MessageSummary[] = [];
    for (const m of c.msgs.values()) {
      if (cut && m.id >= cut) continue;
      const parts = (partsBy.get(m.id) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
      if (!parts.length) {
        out.push(m);
        continue;
      }
      const copy: MessageSummary = { ...m, tools: [...parts.map((p) => p.tool).filter((t): t is ToolSummary => !!t), ...m.tools] };
      if (m.type === 'user' && copy.text === undefined) {
        const texts = parts.filter((p) => p.text !== undefined && !p.synthetic).map((p) => p.text);
        if (texts.length) copy.text = texts.join('\n');
        else if (parts.some((p) => p.synthetic)) copy.synthetic = true;
      }
      const retry = parts.filter((p) => p.retry).pop()?.retry;
      if (retry && !copy.retry) copy.retry = retry;
      out.push(copy);
    }
    return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private toSession(c: Cached, ctx: AdapterContext): AgentSession | undefined {
    const layout = this.layout!;
    c.fold ??= foldOpenCode(this.ordered(c), ctx.pricing, c.todos);
    const f = c.fold;
    const row = c.row;
    const now = ctx.now();
    const live = this.probeService ? this.live.get(c.id, now) : undefined;
    let { status, detail, activity, trouble } = openCodeStatus(f, row, layout, this.label, live);
    const updatedAt = Math.max(num(row.time_updated), f.lastAt);
    if (status === 'working') {
      if (this.probeService && this.live.serviceGone()) {
        status = 'idle';
        detail = `${this.label} was closed`;
        activity = undefined;
      } else {
        const stale = staleness(updatedAt, ctx);
        if (stale) {
          status = 'stale';
          detail = stale;
          activity = undefined;
          trouble = undefined;
        }
      }
    }
    const rowTitle = typeof row.title === 'string' ? row.title.trim() : '';
    const untitled = !rowTitle || /^(New session|Child session)( - \d{4}-\d\d-\d\dT[\d:.]+Z?)?$/.test(rowTitle);
    const title = untitled ? f.title : truncate(rowTitle, 100);
    const model = parseData(row.model);
    const dir = typeof row.directory === 'string' && row.directory ? row.directory.replace(/\//g, path.sep === '\\' ? '\\' : '/') : undefined;
    const rowTokens: TokenUsage | undefined =
      'tokens_input' in row
        ? {
            input: num(row.tokens_input),
            output: num(row.tokens_output) + num(row.tokens_reasoning),
            cacheRead: num(row.tokens_cache_read),
            cacheWrite: num(row.tokens_cache_write),
            reasoning: num(row.tokens_reasoning),
          }
        : undefined;
    const tokens = rowTokens && totalTokens(rowTokens) >= totalTokens(f.tokens) ? rowTokens : { ...f.tokens };
    const rowCost = num(row.cost);
    const loop = status === 'working' || status === 'stale' ? f.loops.current(now) : undefined;
    const children = this.busyChildren.get(c.id);
    return {
      key: `${this.id}:${c.id}`,
      agent: this.id,
      agentLabel: this.label,
      id: c.id,
      title: title ?? 'Untitled session',
      titleFromPrompt: untitled && title !== undefined ? true : undefined,
      projectPath: dir ? (findGitRoot(dir) ?? dir) : undefined,
      cwd: dir,
      model: f.model ?? (typeof model?.id === 'string' ? model.id : undefined),
      agentVersion: typeof row.version === 'string' ? row.version : undefined,
      status,
      statusDetail: detail,
      startedAt: num(row.time_created) || f.startedAt || updatedAt,
      updatedAt,
      tasks: f.tasks,
      activity: status === 'working' || status === 'waiting' ? activity : undefined,
      turn: f.turn,
      turns: f.turns,
      current: status === 'working' || status === 'stale' ? f.timer.current(f.tasks) : undefined,
      recent: f.recent.slice(0, 5),
      loop: loop
        ? {
            label: loop.label,
            detail: loop.detail,
            count: loop.count,
            sameError: loop.sameError,
            since: loop.since,
            tokens: loop.tokensAtStart !== undefined ? totalTokens(f.tokens) - loop.tokensAtStart : undefined,
          }
        : undefined,
      trouble,
      tokens,
      costUsd: f.priced || rowCost > 0 ? Math.max(rowCost, f.costUsd) : undefined,
      daily: f.daily,
      context: f.context ? { used: f.context } : undefined,
      activeSubagents: children || undefined,
      sources: [this.dbFile ?? this.databaseFile(ctx)],
    };
  }
}

/**
 * Asks the local OpenCode service which permission prompts and questions are open. Requests go
 * only to a service on this computer (a loopback address), as GET requests, with the password
 * the service wrote for its own clients; answers arrive in the background and are used on the
 * next poll.
 */
class LiveProbe {
  private service: { url: string; auth?: string; pid?: number; checkedAt: number; alive?: boolean } | undefined;
  private readonly waits = new Map<string, { at: number; wait: LiveWait }>();
  private inFlight = false;
  private lastAsk = 0;

  serviceGone(): boolean {
    return this.service?.alive === false;
  }

  get(id: string, now: number): LiveWait | undefined {
    const w = this.waits.get(id);
    return w && now - w.at < 10_000 ? w.wait : undefined;
  }

  async refresh(ctx: AdapterContext, busy: string[]): Promise<void> {
    const now = ctx.now();
    if (!this.service || now - this.service.checkedAt >= 10_000) await this.readService(ctx);
    const s = this.service;
    if (!s?.url || s.alive === false || !busy.length || this.inFlight || now - this.lastAsk < 2_500) return;
    this.inFlight = true;
    this.lastAsk = now;
    void Promise.all(busy.slice(0, 8).map((id) => this.ask(s, id, now))).finally(() => {
      this.inFlight = false;
    });
  }

  private async readService(ctx: AdapterContext): Promise<void> {
    const file = path.join(ctx.env.XDG_STATE_HOME || path.join(ctx.home, '.local', 'state'), 'opencode', 'service.json');
    const info = await readJsonSafe<Record<string, any>>(file, 64 << 10);
    const now = ctx.now();
    if (!info || typeof info.url !== 'string') {
      this.service = { url: '', checkedAt: now };
      return;
    }
    let loopback = false;
    try {
      const u = new URL(info.url);
      loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
    } catch {
      loopback = false;
    }
    const pid = typeof info.pid === 'number' ? info.pid : undefined;
    let alive: boolean | undefined;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    this.service = {
      url: loopback ? info.url : '',
      auth: typeof info.password === 'string' ? `Basic ${Buffer.from(`opencode:${info.password}`).toString('base64')}` : undefined,
      pid,
      alive,
      checkedAt: now,
    };
  }

  private async ask(s: { url: string; auth?: string }, id: string, now: number): Promise<void> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (s.auth) headers.authorization = s.auth;
    const get = async (p: string): Promise<any[] | undefined> => {
      try {
        const res = await fetch(new URL(p, s.url), { headers, signal: AbortSignal.timeout(1_500) });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { data?: unknown };
        return Array.isArray(body?.data) ? body.data : undefined;
      } catch {
        return undefined;
      }
    };
    const enc = encodeURIComponent(id);
    const [perms, forms] = await Promise.all([get(`/api/session/${enc}/permission`), get(`/api/session/${enc}/form`)]);
    if (perms === undefined && forms === undefined) return;
    const p = perms?.[0];
    const what = p ? [String(p.action ?? 'a tool'), Array.isArray(p.resources) && typeof p.resources[0] === 'string' ? truncate(p.resources[0], 60) : ''].filter(Boolean).join(' ') : undefined;
    this.waits.set(id, { at: now, wait: { permission: what, question: !!forms?.length } });
  }
}

export class OpenCodeAdapter extends OpenCodeFamilyAdapter {
  readonly id = 'opencode';
  readonly label = 'OpenCode';
  protected readonly app = 'opencode';
  protected readonly dbEnv = 'OPENCODE_DB';
  protected override readonly probeService = true;
}

export class KiloCodeAdapter extends OpenCodeFamilyAdapter {
  readonly id = 'kilo-code';
  readonly label = 'Kilo Code';
  protected readonly app = 'kilo';
  protected readonly dbEnv = 'KILO_DB';
}
