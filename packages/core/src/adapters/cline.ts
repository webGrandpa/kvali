/**
 * Cline and Roo Code adapters.
 *
 * Both are VS Code extensions (Roo Code began as a fork of Cline) that keep one folder per task
 * in the editor's global storage, `<userData>/User/globalStorage/<extension>/tasks/<taskId>/`:
 *
 * - `ui_messages.json`: the chat as the extension shows it, an array of
 *   `{ts, type: "ask"|"say", ask?, say?, text?, partial?}`. It is rewritten whole (temp file and
 *   rename) whenever a message is added or finished; streaming chunks are not written.
 * - Roo Code: `history_item.json` (the task's working folder, subtask links) and
 *   `api_conversation_history.json` (the model, in each request's environment details).
 * - Cline: the task list `state/taskHistory.json` next to `tasks/` holds each task's folder.
 *
 * `<extension>` is `saoudrizwan.claude-dev` (Cline) or `rooveterinaryinc.roo-cline` (Roo Code), in
 * every editor built on VS Code (see util/editors.ts). Cline's standalone builds (JetBrains, the
 * older CLI) use `~/.cline/data` instead, and Cline 4.1+ can also run on its SDK, which keeps
 * sessions in `~/.cline/data/sessions/` (see `ClineSdkSessions`).
 *
 * - Status: the last message. A question or an approval the extension asks for is `waiting` once
 *   it has stood for a few seconds (an auto-approved one is answered at once); an `api_req_started`
 *   without a cost is a request in flight.
 * - Progress: Cline's focus chain (`task_progress`, a markdown checklist), Roo Code's
 *   `update_todo_list`.
 * - Tokens and cost: each `api_req_started` row (`tokensIn`, `tokensOut`, `cacheWrites`,
 *   `cacheReads`, `cost`), as the extension priced them.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { isolated, staleness } from '../adapter.ts';
import type { Activity, AgentId, AgentSession, DailyUsage, SessionStatus, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { emptyTokens, progressOf, totalTokens } from '../model.ts';
import type { Pricing } from '../pricing.ts';
import { parseChecklist } from '../util/checklist.ts';
import { editorUserDataDirs } from '../util/editors.ts';
import { findGitRoot, listDir, readJsonSafe, readTextSafe, statSafe } from '../util/fs.ts';
import { LoopWatch, loopKey } from '../util/loop-watch.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { contentText, errorMessage, firstLine, lookupTable, summarizeCommand, truncate } from '../util/text.ts';
import { addTaskDone, addWork, dayKey, parseTime } from '../util/time.ts';

export interface UiMessage {
  ts: number;
  type: 'ask' | 'say';
  ask?: string;
  say?: string;
  text?: string;
  partial?: boolean;
  /** Roo Code: set once the person (or auto-approval) answered this question or approval. */
  isAnswered?: boolean;
  /** Cline: the model that wrote this message. */
  modelInfo?: { modelId?: string; providerId?: string; mode?: string };
  /** Roo Code: what condensing the context cost. */
  contextCondense?: { cost?: number };
}

/** What a task's side files say about it. */
export interface ClineTaskInfo {
  cwd?: string;
  model?: string;
}

/** A flavor of the format: Cline and Roo Code differ in a few details. */
export type ClineFlavor = 'cline' | 'roo';

/** An approval or question the extension waits on, and how to say what it waits for. */
const WAIT_ASKS = lookupTable<(m: UiMessage, label: string) => string>({
  followup: () => 'Asked you a question',
  plan_mode_respond: () => 'Plan ready for your review',
  act_mode_respond: () => 'Waiting for your reply',
  command: (m) => `Needs approval: run ${summarizeCommand(stripReqApp(m.text ?? ''), 60) ?? 'a command'}`,
  tool: (m) => `Needs approval: ${toolActivity(m)?.label ?? 'a tool'}`,
  use_mcp_server: (m) => `Needs approval: ${toolActivity(m)?.label ?? 'an MCP tool'}`,
  browser_action_launch: () => 'Needs approval: open the browser',
  use_subagents: () => 'Needs approval: start subagents',
  new_task: () => 'Wants to start a new task',
  condense: () => 'Wants to condense the conversation',
  summarize_task: () => 'Wants to summarize the task',
  report_bug: () => 'Wants to report a bug',
  auto_approval_max_req_reached: (_m, label) => `${label} reached its auto-approve limit`,
});

/** Rows that record bookkeeping, not what the agent is doing. */
const QUIET_SAYS = new Set([
  'checkpoint_created',
  'checkpoint_saved',
  'hook_status',
  'hook_output_stream',
  'conditional_rules_applied',
  'api_req_finished',
  'shell_integration_warning',
  'shell_integration_warning_with_suggestion',
  'too_many_tools_warning',
  'info',
]);

/** Rows that report a failure of the action just before them. */
const FAILURE_SAYS = new Set(['error', 'diff_error', 'clineignore_error', 'rooignore_error', 'command_permission_denied']);

/** An auto-approved ask is answered at once; one that stands this long waits for the person. */
export const ASK_GRACE_MS = 3_000;

interface ApiReqInfo {
  tokensIn?: number;
  tokensOut?: number;
  cacheWrites?: number;
  cacheReads?: number;
  cost?: number;
  cancelReason?: string;
  streamingFailedMessage?: string;
  apiProtocol?: string;
  retryStatus?: { attempt?: number; maxAttempts?: number; delaySec?: number; errorSnippet?: string };
}

function parseJson<T = Record<string, any>>(text: string | undefined): T | undefined {
  if (!text || (text[0] !== '{' && text[0] !== '[')) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Cline marks a command the model wants approved with a trailing `REQ_APP`. */
function stripReqApp(cmd: string): string {
  const t = cmd.trimEnd();
  return t.endsWith('REQ_APP') ? t.slice(0, -'REQ_APP'.length).trimEnd() : cmd;
}

const TOOL_LABELS = lookupTable<string>({
  editedExistingFile: 'Edit',
  appliedDiff: 'Edit',
  insertContent: 'Edit',
  searchAndReplace: 'Edit',
  newFileCreated: 'Write',
  fileDeleted: 'Delete',
  readFile: 'Read',
  readCommandOutput: 'Read output',
  listFilesTopLevel: 'List files',
  listFilesRecursive: 'List files',
  listCodeDefinitionNames: 'List definitions',
  searchFiles: 'Search',
  codebaseSearch: 'Search codebase',
  webFetch: 'Fetch',
  webSearch: 'Web search',
  summarizeTask: 'Summarize',
  useSkill: 'Skill',
  skill: 'Skill',
  switchMode: 'Switch mode',
  newTask: 'Start a subtask',
  finishTask: 'Finish subtask',
  generateImage: 'Generate image',
  imageGenerated: 'Generate image',
  runSlashCommand: 'Slash command',
  updateTodoList: 'Update plan',
});

/** The action a tool, command, MCP or browser row describes. */
function toolActivity(m: UiMessage): Activity | undefined {
  const kind = m.type === 'ask' ? m.ask : m.say;
  const at = m.ts;
  switch (kind) {
    case 'command': {
      const cmd = stripReqApp(m.text ?? '');
      return { kind: 'command', label: 'Shell', detail: summarizeCommand(cmd), startedAt: at };
    }
    case 'tool': {
      const t = parseJson(m.text);
      if (!t || typeof t.tool !== 'string') return undefined;
      const label = TOOL_LABELS[t.tool] ?? t.tool;
      const target = typeof t.path === 'string' ? t.path : typeof t.regex === 'string' ? t.regex : typeof t.query === 'string' ? t.query : undefined;
      return { kind: 'tool', label, detail: target ? truncate(target, 80) : undefined, startedAt: at };
    }
    case 'use_mcp_server': {
      const t = parseJson(m.text);
      if (!t) return { kind: 'tool', label: 'MCP', startedAt: at };
      const server = typeof t.serverName === 'string' ? t.serverName : 'MCP';
      const what = t.type === 'access_mcp_resource' ? 'resource' : typeof t.toolName === 'string' ? t.toolName : 'tool';
      return { kind: 'tool', label: `${server}: ${what}`, detail: typeof t.uri === 'string' ? truncate(t.uri, 80) : undefined, startedAt: at };
    }
    case 'browser_action_launch':
      return { kind: 'tool', label: 'Browser', detail: m.text ? truncate(m.text, 80) : undefined, startedAt: at };
    case 'browser_action': {
      const t = parseJson(m.text);
      return { kind: 'tool', label: 'Browser', detail: typeof t?.action === 'string' ? t.action : undefined, startedAt: at };
    }
    case 'use_subagents': {
      const t = parseJson(m.text);
      const n = Array.isArray(t?.prompts) ? t.prompts.length : 0;
      return { kind: 'subagent', label: 'Subagents', detail: n ? `${n} subagent${n === 1 ? '' : 's'}` : undefined, startedAt: at };
    }
    default:
      return undefined;
  }
}

/** Everything a task's messages say, folded once per change of the file. */
export interface ClineFold {
  title?: string;
  startedAt: number;
  /** When the last message was added. */
  lastTs: number;
  tokens: TokenUsage;
  costUsd?: number;
  daily: Record<string, DailyUsage>;
  context?: number;
  model?: string;
  tasks: TaskItem[];
  timer: TaskTimer;
  /** Newest first. */
  recent: Activity[];
  turn?: { steps: number; startedAt: number };
  loops: LoopWatch;
  /** The last message that says what the agent is doing. */
  tail?: UiMessage;
  /** The last request's info, when it is the tail. */
  tailRequest?: ApiReqInfo;
  turns: number;
}

function todoStatus(s: unknown): TaskStatus {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

/** Cline's checklist only checks items off: the first unchecked one is the step in progress. */
function withCurrentStep(tasks: TaskItem[]): TaskItem[] {
  if (tasks.some((t) => t.status === 'in_progress')) return tasks;
  const next = tasks.findIndex((t) => t.status === 'pending');
  if (next === -1) return tasks;
  return tasks.map((t, i) => (i === next ? { ...t, status: 'in_progress' } : t));
}

/** Reads a task's `ui_messages.json` rows into one summary. Pure apart from `pricing`. */
export function foldClineMessages(messages: readonly UiMessage[], flavor: ClineFlavor, pricing: Pricing): ClineFold {
  const daily: Record<string, DailyUsage> = {};
  const tokens = emptyTokens();
  let costUsd: number | undefined = 0;
  const fold: ClineFold = {
    startedAt: 0,
    lastTs: 0,
    tokens,
    daily,
    tasks: [],
    timer: new TaskTimer((at) => addTaskDone(daily, at)),
    recent: [],
    loops: new LoopWatch(),
    turns: 0,
  };
  let prevTs: number | undefined;
  let pending: { key: string; what: Activity; failed: boolean } | undefined;
  let turnStart: number | undefined;
  let steps = 0;

  const settle = () => {
    if (pending && !pending.failed) fold.loops.observe(pending.key, pending.what, undefined, pending.what.startedAt);
    pending = undefined;
  };

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || typeof m.ts !== 'number') continue;
    const kind = m.type === 'ask' ? m.ask : m.say;
    if (!fold.startedAt || m.ts < fold.startedAt) fold.startedAt = m.ts;
    if (m.ts > fold.lastTs) fold.lastTs = m.ts;
    if (m.modelInfo?.modelId) fold.model = m.modelInfo.modelId;

    const fromPerson = i === 0 || kind === 'user_feedback' || kind === 'user_feedback_diff';
    if (i === 0 && m.type === 'say' && (kind === 'task' || kind === 'text') && m.text?.trim()) fold.title = firstLine(m.text, 100);
    if (fromPerson) {
      turnStart = m.ts;
      steps = 0;
      fold.turns += 1;
      fold.loops.reset();
      pending = undefined;
      prevTs = m.ts;
    } else if (kind !== 'resume_task' && kind !== 'resume_completed_task') {
      // The agent's own rows close a stretch of its work; the person's do not.
      addWork(daily, prevTs, m.ts);
      prevTs = Math.max(prevTs ?? 0, m.ts);
    }

    if (m.type === 'say' && (kind === 'api_req_started' || kind === 'deleted_api_reqs' || kind === 'api_req_deleted')) {
      const info = parseJson<ApiReqInfo>(m.text);
      if (info && (info.tokensIn !== undefined || info.tokensOut !== undefined || info.cost !== undefined)) {
        const cacheReads = Number(info.cacheReads) || 0;
        const cacheWrites = Number(info.cacheWrites) || 0;
        let input = Number(info.tokensIn) || 0;
        // Roo Code counts cached tokens in `tokensIn` (it records the request's protocol since then).
        if (flavor === 'roo' && info.apiProtocol !== undefined) input = Math.max(0, input - cacheReads - cacheWrites);
        const output = Number(info.tokensOut) || 0;
        tokens.input += input;
        tokens.output += output;
        tokens.cacheRead += cacheReads;
        tokens.cacheWrite += cacheWrites;
        let cost = typeof info.cost === 'number' && Number.isFinite(info.cost) ? info.cost : undefined;
        if (cost === undefined) cost = pricing.cost(fold.model, { input, output, cacheRead: cacheReads, cacheWrite5m: cacheWrites, cacheWrite1h: 0 });
        if (cost === undefined) {
          if (input + output > 0) costUsd = undefined;
        } else if (costUsd !== undefined) costUsd += cost;
        const b = (daily[dayKey(m.ts)] ??= { tokens: 0, costUsd: 0 });
        b.tokens += input + output + cacheReads + cacheWrites;
        b.costUsd += cost ?? 0;
        if (kind === 'api_req_started' && input + cacheReads + cacheWrites > 0) fold.context = input + cacheReads + cacheWrites;
      }
    } else if (kind === 'condense_context' && typeof m.contextCondense?.cost === 'number') {
      if (costUsd !== undefined) costUsd += m.contextCondense.cost;
      const b = (daily[dayKey(m.ts)] ??= { tokens: 0, costUsd: 0 });
      b.costUsd += m.contextCondense.cost;
    }

    // The plan.
    if (!m.partial) {
      let plan: TaskItem[] | undefined;
      if (kind === 'task_progress' && m.text) plan = withCurrentStep(parseChecklist(m.text).tasks);
      else if ((kind === 'tool' && m.type === 'ask') || kind === 'user_edit_todos') {
        const t = parseJson(m.text);
        if (t?.tool === 'updateTodoList' && Array.isArray(t.todos)) {
          plan = t.todos.map((todo: any, n: number) => ({
            id: typeof todo?.id === 'string' ? todo.id : String(n + 1),
            title: String(todo?.content ?? ''),
            status: todoStatus(todo?.status),
          }));
        }
      }
      if (plan) {
        fold.tasks = plan;
        fold.timer.observe(plan, m.ts);
      }
    }

    // What it does, and whether it fails.
    const act = m.partial ? undefined : toolActivity(m);
    if (act) {
      settle();
      steps += 1;
      fold.timer.step();
      pending = { key: loopKey(act), what: act, failed: false };
      if (fold.recent[0]) fold.recent[0].endedAt ??= m.ts;
      fold.recent.unshift(act);
      if (fold.recent.length > 6) fold.recent.length = 6;
    } else if (m.type === 'say' && kind && FAILURE_SAYS.has(kind) && pending && !pending.failed) {
      pending.failed = true;
      fold.loops.observe(pending.key, pending.what, m.text || kind, m.ts, totalTokens(tokens));
    } else if (kind === 'api_req_started' && fold.recent[0] && fold.recent[0].endedAt === undefined) {
      fold.recent[0].endedAt = m.ts;
    }

    // An ask waits for the person: the time they take is not the agent's work.
    if (m.type === 'ask' && kind && WAIT_ASKS[kind] && !m.partial) prevTs = undefined;

    if (!(m.type === 'say' && kind && QUIET_SAYS.has(kind))) fold.tail = m;
  }
  settle();

  fold.costUsd = costUsd;
  if (turnStart !== undefined) fold.turn = { steps, startedAt: turnStart };
  const t = fold.tail;
  if (t?.type === 'say' && t.say === 'api_req_started') fold.tailRequest = parseJson<ApiReqInfo>(t.text);
  return fold;
}

/** The session's status at `now`, from its last message. */
export function clineStatus(
  fold: ClineFold,
  label: string,
  now: number,
): { status: SessionStatus; detail?: string; trouble?: AgentSession['trouble']; activity?: Activity } {
  const t = fold.tail;
  if (!t) return { status: 'idle' };
  const kind = t.type === 'ask' ? t.ask : t.say;
  const prog = progressOf(fold.tasks);
  const finished = (detail: string) =>
    prog.total > 0 && prog.done < prog.total ? { status: 'idle' as const, detail } : { status: 'done' as const, detail };
  const working = (detail?: string, trouble?: AgentSession['trouble']) => ({ status: 'working' as const, detail, trouble, activity: fold.recent[0] });

  if (t.type === 'ask' && kind) {
    if (t.partial) return working();
    const wait = WAIT_ASKS[kind];
    if (wait) {
      if (t.isAnswered || now - t.ts < ASK_GRACE_MS) return working();
      return { status: 'waiting', detail: wait(t, label), activity: kind === 'command' || kind === 'tool' || kind === 'use_mcp_server' ? toolActivity(t) : undefined };
    }
    switch (kind) {
      case 'command_output':
        return working('Running a command');
      case 'completion_result':
      case 'resume_completed_task':
        return finished('Task completed');
      case 'resume_task':
        return { status: 'idle', detail: 'Paused' };
      case 'api_req_failed':
        return { status: 'error', detail: firstLine(t.text || 'The API request failed', 140) };
      case 'mistake_limit_reached':
        return { status: 'error', detail: `${label} stopped after repeated mistakes and asks for guidance` };
      default:
        return working();
    }
  }

  switch (kind) {
    case 'api_req_started': {
      const info = fold.tailRequest;
      if (info?.cancelReason === 'user_cancelled') return { status: 'idle', detail: 'Stopped' };
      if (info?.cancelReason === 'streaming_failed' || info?.cancelReason === 'retries_exhausted') {
        return { status: 'error', detail: firstLine(info.streamingFailedMessage || 'The request failed', 140) };
      }
      if (info?.retryStatus) {
        const r = info.retryStatus;
        return working(undefined, {
          message: firstLine(r.errorSnippet || 'Retrying the request', 120),
          at: t.ts,
          attempt: r.attempt,
          maxAttempts: r.maxAttempts,
        });
      }
      return working();
    }
    case 'api_req_retry_delayed':
      return working(undefined, { message: firstLine((t.text ?? '').replace(/<retry_timer>\d+<\/retry_timer>/g, '').trim() || 'Retrying the request', 120), at: t.ts });
    case 'api_req_rate_limit_wait':
      return working(undefined, { message: 'Waiting out a rate limit', at: t.ts });
    case 'completion_result':
      return finished('Task completed');
    default:
      return working();
  }
}

interface TrackedTask {
  id: string;
  dir: string;
  file: string;
  mtimeMs: number;
  size: number;
  readAt: number;
  fold?: ClineFold;
  /** Roo Code side files, re-read when they change. */
  history?: { mtimeMs: number; value?: Record<string, any> };
  modelFile?: { mtimeMs: number; checkedAt: number; model?: string };
}

interface Store {
  /** The extension's folder: holds `tasks/` (and Cline's `state/`). */
  dir: string;
  /** Task folder → when its `ui_messages.json` last changed (0: none). */
  seen: Map<string, number>;
  lastSweep: number;
  indexMtime: number;
  /** Cline's `state/taskHistory.json`: task id → its folder and model. */
  history?: { mtimeMs: number; readAt: number; byId: Map<string, { cwd?: string; model?: string }> };
}

const SWEEP_MS = 30_000;
const DISCOVERY_MS = 5_000;
const MODEL_CHECK_MS = 15_000;
/** A chat this big (pasted screenshots are kept inline) is re-read at most this often. */
const BIG_FILE_BYTES = 8 << 20;
const BIG_FILE_EVERY_MS = 10_000;
/** Cline rewrites its task list with every message; once read, it is re-read at most this often. */
const HISTORY_EVERY_MS = 15_000;

export interface ClineFamilyOptions {
  /** Extra extension folders to read, e.g. the editor Kvali runs in (an exotic or portable install). */
  extraStorageDirs?: readonly string[];
  /** Platform whose editor folders to look in; defaults to this one. */
  platform?: string;
}

/**
 * Reads the extension's tasks wherever an editor keeps them. Subclasses set which extension
 * folders belong to the agent.
 */
abstract class ClineFamilyAdapter implements Adapter {
  abstract readonly id: AgentId;
  abstract readonly label: string;
  protected abstract readonly flavor: ClineFlavor;
  /** Folder names under globalStorage, lower case. */
  protected abstract readonly extensions: readonly string[];

  protected readonly options: ClineFamilyOptions;
  private readonly stores = new Map<string, Store>();
  private readonly tracked = new Map<string, TrackedTask & { store: Store }>();
  private lastDiscovery = 0;
  private lastRootScan = 0;

  constructor(options: ClineFamilyOptions = {}) {
    this.options = options;
  }

  /** Folders outside the editors that hold the agent's `tasks/` (Cline's standalone builds). */
  protected standaloneDirs(_ctx: AdapterContext): string[] {
    return [];
  }

  /** A setting that moves the storage (Roo Code's `customStoragePath`), read from the editors' settings. */
  protected customStorageDirs(_ctx: AdapterContext): Promise<string[]> {
    return Promise.resolve([]);
  }

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (now - this.lastRootScan >= 60_000 || this.stores.size === 0) {
      this.lastRootScan = now;
      await this.findStores(ctx);
    }
    if (now - this.lastDiscovery >= DISCOVERY_MS || this.tracked.size === 0) {
      this.lastDiscovery = now;
      await this.discover(ctx);
    }
    const out: AgentSession[] = [];
    const byId = new Map<string, AgentSession>();
    for (const t of this.tracked.values()) {
      const s = await isolated(ctx, `[${this.id}] ${t.id}`, async () => {
        await this.refresh(t, ctx);
        return t.fold ? this.toSession(t, ctx) : undefined;
      });
      if (s) {
        out.push(s);
        byId.set(t.id, s);
      }
    }
    // A Roo Code task that handed its work to a subtask is busy while that subtask is.
    for (const t of this.tracked.values()) {
      const child = t.history?.value?.delegatedToId ?? t.history?.value?.awaitingChildId;
      const s = byId.get(t.id);
      if (!s || typeof child !== 'string' || t.history?.value?.status !== 'delegated') continue;
      const c = byId.get(child);
      if (c && (c.status === 'working' || c.status === 'waiting')) {
        s.status = 'working';
        s.statusDetail = 'A subtask is running';
        s.activity = { kind: 'subagent', label: 'Subtask', detail: truncate(c.title, 80), startedAt: c.startedAt };
        s.activeSubagents = 1;
      } else {
        s.status = 'idle';
        s.statusDetail = 'Waits for its subtask';
        s.activity = undefined;
      }
    }
    return out;
  }

  /** The extension folders that exist, in every editor and profile. */
  private async findStores(ctx: AdapterContext): Promise<void> {
    const dirs = new Set<string>();
    const storageRoots: string[] = [];
    for (const userData of editorUserDataDirs(ctx.home, ctx.env, this.options.platform)) {
      const user = path.join(userData, 'User');
      storageRoots.push(path.join(user, 'globalStorage'));
      for (const p of await listDir(path.join(user, 'profiles'))) if (p.isDirectory()) storageRoots.push(path.join(user, 'profiles', p.name, 'globalStorage'));
    }
    for (const extra of this.options.extraStorageDirs ?? []) storageRoots.push(extra);
    for (const root of storageRoots) {
      for (const e of await listDir(root)) {
        if (e.isDirectory() && this.extensions.includes(e.name.toLowerCase())) dirs.add(path.join(root, e.name));
      }
    }
    for (const d of this.standaloneDirs(ctx)) dirs.add(d);
    for (const d of await this.customStorageDirs(ctx)) dirs.add(d);
    for (const d of dirs) if (!this.stores.has(d)) this.stores.set(d, { dir: d, seen: new Map(), lastSweep: 0, indexMtime: -1 });
    for (const d of [...this.stores.keys()]) if (!dirs.has(d)) this.stores.delete(d);
  }

  /** Which tasks changed recently: a new folder at once, the others every 30 s or when the task list changed. */
  private async discover(ctx: AdapterContext): Promise<void> {
    const now = ctx.now();
    const found: { store: Store; id: string; mtimeMs: number }[] = [];
    for (const store of this.stores.values()) {
      const tasksDir = path.join(store.dir, 'tasks');
      const names = (await listDir(tasksDir)).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map((e) => e.name);
      const index = this.flavor === 'roo' ? path.join(tasksDir, '_index.json') : path.join(store.dir, 'state', 'taskHistory.json');
      const indexMtime = (await statSafe(index))?.mtimeMs ?? 0;
      const sweep = now - store.lastSweep >= SWEEP_MS || indexMtime !== store.indexMtime;
      if (sweep) {
        store.lastSweep = now;
        store.indexMtime = indexMtime;
      }
      const present = new Set(names);
      for (const id of [...store.seen.keys()]) if (!present.has(id)) store.seen.delete(id);
      const toStat = names.filter((id) => sweep || !store.seen.has(id));
      for (let i = 0; i < toStat.length; i += 64) {
        await Promise.all(
          toStat.slice(i, i + 64).map(async (id) => {
            const st = await statSafe(path.join(tasksDir, id, 'ui_messages.json'));
            store.seen.set(id, st?.mtimeMs ?? 0);
          }),
        );
      }
      for (const [id, mtimeMs] of store.seen) if (mtimeMs && now - mtimeMs <= ctx.activeWindowMs) found.push({ store, id, mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Map(found.slice(0, ctx.maxSessionsPerAgent).map((f) => [path.join(f.store.dir, 'tasks', f.id), f]));
    for (const [dir, f] of keep) {
      if (this.tracked.has(dir)) continue;
      this.tracked.set(dir, { id: f.id, dir, file: path.join(dir, 'ui_messages.json'), mtimeMs: -1, size: -1, readAt: 0, store: f.store });
    }
    for (const dir of [...this.tracked.keys()]) if (!keep.has(dir)) this.tracked.delete(dir);
  }

  /** Re-reads what changed: the messages, and the side files that say where the task runs. */
  private async refresh(t: TrackedTask & { store: Store }, ctx: AdapterContext): Promise<void> {
    const st = await statSafe(t.file);
    const due = !t.fold || st === undefined || st.size < BIG_FILE_BYTES || ctx.now() - t.readAt >= BIG_FILE_EVERY_MS;
    if (st && due && (st.mtimeMs !== t.mtimeMs || st.size !== t.size)) {
      t.readAt = ctx.now();
      const text = await readTextSafe(t.file, 128 << 20);
      if (text !== undefined) {
        try {
          const messages = JSON.parse(text) as UiMessage[];
          if (Array.isArray(messages)) {
            t.fold = foldClineMessages(messages, this.flavor, ctx.pricing);
            t.mtimeMs = st.mtimeMs;
            t.size = st.size;
            t.store.seen.set(t.id, st.mtimeMs);
          }
        } catch {
          /* caught between the extension's write and rename: read it next time */
        }
      }
    }
    if (this.flavor === 'roo') {
      const hf = path.join(t.dir, 'history_item.json');
      const hs = await statSafe(hf);
      if (hs && hs.mtimeMs !== t.history?.mtimeMs) {
        const value = await readJsonSafe<Record<string, any>>(hf, 4 << 20);
        if (value) t.history = { mtimeMs: hs.mtimeMs, value };
      }
      const now = ctx.now();
      if (!t.modelFile || now - t.modelFile.checkedAt >= MODEL_CHECK_MS) {
        const mf = path.join(t.dir, 'api_conversation_history.json');
        const ms = await statSafe(mf);
        const prev = t.modelFile;
        t.modelFile = { mtimeMs: ms?.mtimeMs ?? 0, checkedAt: now, model: prev?.model };
        if (ms && ms.mtimeMs !== prev?.mtimeMs) t.modelFile.model = (await lastModelIn(mf, ms.size)) ?? prev?.model;
      }
    } else {
      await this.readClineHistory(t.store, t.id, ctx.now());
    }
  }

  /** Cline's task list, re-read when it changes (or sooner for a task it did not list yet). */
  private async readClineHistory(store: Store, id: string, now: number): Promise<void> {
    if (store.history && store.history.byId.has(id) && now - store.history.readAt < HISTORY_EVERY_MS) return;
    if (store.history && now - store.history.readAt < 2_000) return;
    const file = path.join(store.dir, 'state', 'taskHistory.json');
    const st = await statSafe(file);
    if (!st || st.mtimeMs === store.history?.mtimeMs) return;
    const items = await readJsonSafe<any[]>(file, 64 << 20);
    if (!Array.isArray(items)) return;
    const byId = new Map<string, { cwd?: string; model?: string }>();
    for (const it of items) {
      if (it && typeof it.id === 'string') {
        byId.set(it.id, {
          cwd: typeof it.cwdOnTaskInitialization === 'string' ? it.cwdOnTaskInitialization : undefined,
          model: typeof it.modelId === 'string' ? it.modelId : undefined,
        });
      }
    }
    store.history = { mtimeMs: st.mtimeMs, readAt: now, byId };
  }

  private info(t: TrackedTask & { store: Store }): ClineTaskInfo {
    if (this.flavor === 'roo') {
      const h = t.history?.value;
      return { cwd: typeof h?.workspace === 'string' && h.workspace ? h.workspace : undefined, model: t.modelFile?.model };
    }
    const h = t.store.history?.byId.get(t.id);
    return { cwd: h?.cwd, model: h?.model };
  }

  private toSession(t: TrackedTask & { store: Store }, ctx: AdapterContext): AgentSession | undefined {
    const f = t.fold;
    if (!f || !f.startedAt) return undefined;
    const info = this.info(t);
    const now = ctx.now();
    let { status, detail, trouble, activity } = clineStatus(f, this.label, now);
    const updatedAt = Math.max(f.lastTs, t.mtimeMs > 0 ? Math.min(t.mtimeMs, now) : 0);
    if (status === 'working') {
      const stale = staleness(updatedAt, ctx);
      if (stale) {
        status = 'stale';
        detail = stale;
        activity = undefined;
        trouble = undefined;
      }
    } else if (status !== 'waiting') activity = undefined;
    const loop = status === 'working' || status === 'stale' ? f.loops.current(now) : undefined;
    const cwd = info.cwd;
    return {
      key: `${this.id}:${t.id}`,
      agent: this.id,
      agentLabel: this.label,
      id: t.id,
      title: f.title ?? 'Untitled task',
      titleFromPrompt: f.title !== undefined ? true : undefined,
      projectPath: cwd ? (findGitRoot(cwd) ?? cwd) : undefined,
      cwd,
      model: f.model ?? info.model,
      host: 'editor',
      status,
      statusDetail: detail,
      startedAt: f.startedAt,
      updatedAt,
      tasks: f.tasks,
      activity,
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
      tokens: { ...f.tokens },
      costUsd: f.costUsd,
      daily: f.daily,
      context: f.context ? { used: f.context } : undefined,
      sources: [t.file],
    };
  }
}

/** The model in the last request's environment details (Roo Code), from the end of the file. */
async function lastModelIn(file: string, size: number): Promise<string | undefined> {
  const len = Math.min(size, 512 << 10);
  if (len <= 0) return undefined;
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const text = buf.toString('utf8');
    const all = [...text.matchAll(/<model>([^<]{1,200})<\/model>/g)];
    return all.length ? all[all.length - 1][1].trim() : undefined;
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Where Cline keeps its data outside the editors: `CLINE_DATA_DIR`, `$CLINE_DIR/data`, `~/.cline/data`. */
export function clineDataDir(home: string, env: Record<string, string | undefined>): string {
  if (env.CLINE_DATA_DIR) return env.CLINE_DATA_DIR;
  if (env.CLINE_DIR) return path.join(env.CLINE_DIR, 'data');
  return path.join(home, '.cline', 'data');
}

export class ClineAdapter extends ClineFamilyAdapter {
  readonly id = 'cline';
  readonly label = 'Cline';
  protected readonly flavor = 'cline';
  protected readonly extensions = ['saoudrizwan.claude-dev', 'saoudrizwan.cline-nightly'];
  private readonly sdk = new ClineSdkSessions();

  protected override standaloneDirs(ctx: AdapterContext): string[] {
    return [clineDataDir(ctx.home, ctx.env)];
  }

  override async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    return [...(await super.poll(ctx)), ...(await this.sdk.poll(ctx, this.label))];
  }
}

export class RooCodeAdapter extends ClineFamilyAdapter {
  readonly id = 'roo-code';
  readonly label = 'Roo Code';
  protected readonly flavor = 'roo';
  protected readonly extensions = ['rooveterinaryinc.roo-cline', 'rooveterinaryinc.roo-code-nightly'];

  /** `roo-cline.customStoragePath` in the editors' user settings moves the whole folder. */
  protected override async customStorageDirs(ctx: AdapterContext): Promise<string[]> {
    const out: string[] = [];
    for (const userData of editorUserDataDirs(ctx.home, ctx.env, this.options.platform)) {
      const text = await readTextSafe(path.join(userData, 'User', 'settings.json'), 2 << 20);
      const m = text && /"roo-cline\.customStoragePath"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(text);
      if (m) {
        try {
          out.push(JSON.parse(`"${m[1]}"`) as string);
        } catch {
          /* not a JSON string */
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Cline SDK sessions: ~/.cline/data/sessions/<id>/<id>.json and <id>.messages.json

interface SdkTracked {
  dir: string;
  id: string;
  manifestFile: string;
  manifestMtime: number;
  manifest?: Record<string, any>;
  messagesFile?: string;
  messagesMtime: number;
  messagesSize: number;
  fold?: SdkFold;
}

interface SdkFold {
  title?: string;
  startedAt?: number;
  lastTs: number;
  tokens: TokenUsage;
  costUsd?: number;
  daily: Record<string, DailyUsage>;
  model?: string;
  context?: number;
  recent: Activity[];
  turn?: { steps: number; startedAt: number };
  turns: number;
  loops: LoopWatch;
  /** The last message is an error the SDK showed. */
  lastError?: string;
}

const SDK_TOOL_LABELS = lookupTable<string>({
  read_files: 'Read',
  search_codebase: 'Search',
  run_commands: 'Shell',
  fetch_web_content: 'Fetch',
  apply_patch: 'Edit',
  editor: 'Edit',
  skills: 'Skill',
  ask_question: 'Question',
  submit_and_exit: 'Finishing',
  attempt_completion: 'Finishing',
  execute_command: 'Shell',
  read_file: 'Read',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
});

function sdkActivity(block: Record<string, any>, at: number): Activity {
  const name = String(block.name ?? 'tool');
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (name === 'run_commands' || name === 'execute_command') {
    const cmds = Array.isArray(input.commands) ? input.commands : [input.command];
    const first = cmds[0];
    const text = typeof first === 'string' ? first : first && typeof first === 'object' ? [first.command, ...(Array.isArray(first.args) ? first.args : [])].join(' ') : undefined;
    return { kind: 'command', label: 'Shell', detail: summarizeCommand(text), startedAt: at };
  }
  const mcp = /^(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: 'tool', label: `${mcp[1]}: ${mcp[2]}`, startedAt: at };
  const files = Array.isArray(input.files) ? input.files : undefined;
  const target =
    typeof input.path === 'string' ? input.path : typeof files?.[0]?.path === 'string' ? files[0].path : typeof input.query === 'string' ? input.query : undefined;
  return { kind: 'tool', label: SDK_TOOL_LABELS[name] ?? name, detail: target ? truncate(target, 80) : undefined, startedAt: at };
}

/** The text of a failed command in a `run_commands` result, if one failed. */
function sdkFailure(result: Record<string, any>): string | undefined {
  if (result.is_error) return contentText(result.content) || (typeof result.content === 'string' ? result.content : 'Tool error');
  let content: unknown = result.content;
  if (typeof content === 'string' && content.startsWith('[')) {
    try {
      content = JSON.parse(content);
    } catch {
      /* plain text */
    }
  }
  if (!Array.isArray(content)) return undefined;
  const failed = content.find((c: any) => c && typeof c === 'object' && c.success === false);
  return failed ? (errorMessage(failed.error) ?? errorMessage(failed.result) ?? 'Command failed') : undefined;
}

/** Strips the `<user_input mode="…">` wrapper the SDK puts around what the person typed. */
function sdkUserText(content: unknown): string {
  const text = contentText(content);
  const m = /<user_input[^>]*>([\s\S]*?)<\/user_input>/.exec(text);
  return (m ? m[1] : text).trim();
}

export function foldClineSdkMessages(messages: readonly Record<string, any>[]): SdkFold {
  const daily: Record<string, DailyUsage> = {};
  const fold: SdkFold = { lastTs: 0, tokens: emptyTokens(), costUsd: 0, daily, recent: [], turns: 0, loops: new LoopWatch() };
  const calls = new Map<string, Activity>();
  let prevTs: number | undefined;
  let steps = 0;
  let turnStart: number | undefined;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const ts = parseTime(m.ts) ?? 0;
    if (ts) {
      if (fold.startedAt === undefined || ts < fold.startedAt) fold.startedAt = ts;
      if (ts > fold.lastTs) fold.lastTs = ts;
    }
    const blocks: Record<string, any>[] = Array.isArray(m.content) ? m.content.filter((b: unknown) => b && typeof b === 'object') : [];
    const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
    if (m.role === 'user') {
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length === 0 && !meta.kind) {
        const text = sdkUserText(m.content);
        if (text) {
          if (!fold.title) fold.title = firstLine(text, 100);
          turnStart = ts || turnStart;
          steps = 0;
          fold.turns += 1;
          fold.loops.reset();
          prevTs = ts || prevTs;
        }
      }
      for (const r of results) {
        const act = calls.get(String(r.tool_use_id));
        if (!act) continue;
        act.endedAt ??= ts || undefined;
        fold.loops.observe(loopKey(act), act, sdkFailure(r), ts, totalTokens(fold.tokens));
      }
      if (results.length && ts) {
        addWork(daily, prevTs, ts);
        prevTs = Math.max(prevTs ?? 0, ts);
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    if (ts) {
      addWork(daily, prevTs, ts);
      prevTs = Math.max(prevTs ?? 0, ts);
    }
    if (meta.displayRole === 'error') fold.lastError = firstLine(contentText(m.content) || 'Error', 140);
    else if (!meta.displayOnly) fold.lastError = undefined;
    const model = m.modelInfo?.id;
    if (typeof model === 'string') fold.model = model;
    const u = m.metrics;
    if (u && typeof u === 'object') {
      const cacheRead = Number(u.cacheReadTokens) || 0;
      const cacheWrite = Number(u.cacheWriteTokens) || 0;
      const prompt = Number(u.inputTokens) || 0;
      const input = Math.max(0, prompt - cacheRead - cacheWrite);
      const output = Number(u.outputTokens) || 0;
      fold.tokens.input += input;
      fold.tokens.output += output;
      fold.tokens.cacheRead += cacheRead;
      fold.tokens.cacheWrite += cacheWrite;
      const cost = typeof u.cost === 'number' ? u.cost : undefined;
      if (cost === undefined) {
        if (input + output > 0) fold.costUsd = undefined;
      } else if (fold.costUsd !== undefined) fold.costUsd += cost;
      const b = (daily[dayKey(ts || Date.now())] ??= { tokens: 0, costUsd: 0 });
      b.tokens += input + output + cacheRead + cacheWrite;
      b.costUsd += cost ?? 0;
      if (prompt > 0) fold.context = prompt;
    }
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      const act = sdkActivity(b, ts);
      calls.set(String(b.id), act);
      steps += 1;
      if (fold.recent[0]) fold.recent[0].endedAt ??= ts || undefined;
      fold.recent.unshift(act);
      if (fold.recent.length > 6) fold.recent.length = 6;
    }
  }
  if (turnStart !== undefined) fold.turn = { steps, startedAt: turnStart };
  return fold;
}

function pidAlive(pid: unknown): boolean | undefined {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Sessions of Cline's SDK (Cline 4.1+ in VS Code, the `cline` CLI, JetBrains). */
export class ClineSdkSessions {
  private readonly tracked = new Map<string, SdkTracked>();
  private lastDiscovery = 0;

  private root(ctx: AdapterContext): string {
    return ctx.env.CLINE_SESSION_DATA_DIR || path.join(clineDataDir(ctx.home, ctx.env), 'sessions');
  }

  async poll(ctx: AdapterContext, label: string): Promise<AgentSession[]> {
    const now = ctx.now();
    if (now - this.lastDiscovery >= DISCOVERY_MS || this.tracked.size === 0) {
      this.lastDiscovery = now;
      await this.discover(ctx);
    }
    const out: AgentSession[] = [];
    for (const t of this.tracked.values()) {
      const s = await isolated(ctx, `[${label}] ${t.id}`, async () => {
        await this.refresh(t);
        return this.toSession(t, ctx, label);
      });
      if (s) out.push(s);
    }
    return out;
  }

  private async discover(ctx: AdapterContext): Promise<void> {
    const root = this.root(ctx);
    const now = ctx.now();
    const found: { dir: string; id: string; mtimeMs: number }[] = [];
    for (const e of await listDir(root)) {
      // `<root>__<agent>` folders are subagents and teammates of a session, not sessions.
      if (!e.isDirectory() || e.name.includes('__') || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      const manifest = await statSafe(path.join(dir, `${e.name}.json`));
      const messages = await statSafe(path.join(dir, `${e.name}.messages.json`));
      const mtimeMs = Math.max(manifest?.mtimeMs ?? 0, messages?.mtimeMs ?? 0);
      if (mtimeMs && now - mtimeMs <= ctx.activeWindowMs) found.push({ dir, id: e.name, mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = new Map(found.slice(0, ctx.maxSessionsPerAgent).map((f) => [f.dir, f]));
    for (const [dir, f] of keep) {
      if (!this.tracked.has(dir)) {
        this.tracked.set(dir, { dir, id: f.id, manifestFile: path.join(dir, `${f.id}.json`), manifestMtime: -1, messagesMtime: -1, messagesSize: -1 });
      }
    }
    for (const dir of [...this.tracked.keys()]) if (!keep.has(dir)) this.tracked.delete(dir);
  }

  private async refresh(t: SdkTracked): Promise<void> {
    const ms = await statSafe(t.manifestFile);
    if (ms && ms.mtimeMs !== t.manifestMtime) {
      const m = await readJsonSafe<Record<string, any>>(t.manifestFile, 8 << 20);
      if (m) {
        t.manifest = m;
        t.manifestMtime = ms.mtimeMs;
      }
    }
    // The transcript sits next to the manifest; the manifest may name another place for it.
    const declared = typeof t.manifest?.messages_path === 'string' ? t.manifest.messages_path : undefined;
    let file = path.join(t.dir, `${t.id}.messages.json`);
    let st = await statSafe(file);
    if (!st && declared) {
      st = await statSafe(declared);
      if (st) file = declared;
    }
    t.messagesFile = file;
    if (st && (st.mtimeMs !== t.messagesMtime || st.size !== t.messagesSize)) {
      const doc = await readJsonSafe<Record<string, any>>(t.messagesFile, 128 << 20);
      if (doc && Array.isArray(doc.messages)) {
        t.fold = foldClineSdkMessages(doc.messages);
        t.messagesMtime = st.mtimeMs;
        t.messagesSize = st.size;
      }
    }
  }

  private toSession(t: SdkTracked, ctx: AdapterContext, label: string): AgentSession | undefined {
    const m = t.manifest;
    if (!m) return undefined;
    if (m.is_subagent === true || m.is_subagent === 1) return undefined;
    const f = t.fold;
    const now = ctx.now();
    const meta = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
    const startedAt = parseTime(m.started_at) ?? f?.startedAt ?? Math.min(t.manifestMtime, now);
    const updatedAt = Math.max(f?.lastTs ?? 0, parseTime(m.ended_at) ?? 0, Math.min(Math.max(t.manifestMtime, t.messagesMtime), now));
    let status: SessionStatus;
    let detail: string | undefined;
    switch (m.status) {
      case 'running':
      case 'pending':
        status = 'working';
        if (m.status === 'pending') detail = 'Queued';
        if (pidAlive(m.pid) === false) {
          status = 'idle';
          detail = `${label} was closed`;
        }
        break;
      case 'completed':
        status = 'done';
        break;
      case 'failed':
        status = 'error';
        detail = f?.lastError ?? (typeof meta.terminal_marker_reason === 'string' ? meta.terminal_marker_reason : 'The session failed');
        break;
      case 'cancelled':
        status = 'idle';
        detail = 'Stopped';
        break;
      default:
        status = f?.lastError ? 'error' : 'idle';
        detail = f?.lastError;
    }
    let activity = status === 'working' ? f?.recent[0] : undefined;
    if (status === 'working') {
      const stale = staleness(updatedAt, ctx);
      if (stale) {
        status = 'stale';
        detail = stale;
        activity = undefined;
      }
    }
    const usage = meta.aggregateUsage ?? meta.usage;
    const cwd = typeof m.cwd === 'string' ? m.cwd : typeof m.workspace_root === 'string' ? m.workspace_root : undefined;
    const root = typeof m.workspace_root === 'string' ? m.workspace_root : undefined;
    const title = typeof meta.title === 'string' && meta.title.trim() ? firstLine(meta.title, 100) : (f?.title ?? (typeof m.prompt === 'string' ? firstLine(sdkUserText(m.prompt), 100) : undefined));
    const loop = status === 'working' || status === 'stale' ? f?.loops.current(now) : undefined;
    let costUsd = f?.costUsd;
    if (typeof usage?.totalCost === 'number' && (costUsd === undefined || usage.totalCost > costUsd)) costUsd = usage.totalCost;
    return {
      key: `cline:${t.id}`,
      agent: 'cline',
      agentLabel: label,
      id: t.id,
      title: title ?? 'Untitled task',
      titleFromPrompt: title !== undefined ? true : undefined,
      projectPath: root ? (findGitRoot(root) ?? root) : cwd ? (findGitRoot(cwd) ?? cwd) : undefined,
      cwd,
      model: f?.model ?? (typeof m.model === 'string' ? m.model : undefined),
      host: m.source === 'vscode' ? 'editor' : m.source === 'cli' ? 'terminal' : m.source ? 'app' : undefined,
      pid: typeof m.pid === 'number' && pidAlive(m.pid) ? m.pid : undefined,
      status,
      statusDetail: detail,
      startedAt,
      updatedAt,
      tasks: [],
      activity,
      turn: f?.turn,
      turns: f?.turns,
      recent: f?.recent.slice(0, 5),
      loop: loop
        ? {
            label: loop.label,
            detail: loop.detail,
            count: loop.count,
            sameError: loop.sameError,
            since: loop.since,
            tokens: loop.tokensAtStart !== undefined && f ? totalTokens(f.tokens) - loop.tokensAtStart : undefined,
          }
        : undefined,
      tokens: f ? { ...f.tokens } : undefined,
      costUsd,
      daily: f?.daily,
      context: f?.context ? { used: f.context } : undefined,
      sources: [t.messagesFile ?? t.manifestFile, t.manifestFile].filter((x, i, a) => a.indexOf(x) === i),
    };
  }
}
