/**
 * The normalized data model every adapter produces.
 *
 * Adapters translate an agent's own files (transcripts, plans, logs) into
 * `AgentSession` objects. Frontends (VS Code extension, CLI) only ever see this
 * model, so supporting a new agent never requires UI changes.
 */

export type AgentId =
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'antigravity'
  | 'progress-file'
  | (string & {});

/**
 * - `working`  the agent is generating or running a tool
 * - `waiting`  the agent is blocked on you (permission prompt, question)
 * - `idle`     the turn finished; the agent waits for your next prompt
 * - `done`     idle, and every task in its plan is completed
 * - `error`    the last turn ended with an error
 * - `stale`    looked busy, but nothing was written for a long time
 */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'done' | 'error' | 'stale';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

export interface TaskItem {
  id: string;
  title: string;
  /** Present-continuous label, e.g. "Running tests" (Claude Code `activeForm`). */
  activeTitle?: string;
  status: TaskStatus;
  /** Nesting level for markdown checklists (0 = top level). */
  depth?: number;
  /** Section heading the task belongs to, e.g. "Phase 2: API". */
  group?: string;
}

export interface TokenUsage {
  /** Input tokens that were not served from cache. */
  input: number;
  /** Output tokens, including reasoning/thinking tokens. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Reasoning/thinking tokens (a subset of `output`), when reported. */
  reasoning?: number;
}

export interface RateLimitWindow {
  /** Human label, e.g. "5h" or "Weekly". */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  windowMinutes?: number;
}

export interface Activity {
  kind: 'tool' | 'command' | 'thinking' | 'message' | 'subagent' | 'other';
  /** Short label, e.g. "Bash", "Edit", "Running pnpm test". */
  label: string;
  /** Extra detail, e.g. the command line or file path. */
  detail?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** When the action finished; undefined while it runs. */
  endedAt?: number;
}

export interface DailyUsage {
  tokens: number;
  costUsd: number;
}

export interface AgentSession {
  /** Globally unique: `${agent}:${id}`. */
  key: string;
  agent: AgentId;
  agentLabel: string;
  id: string;
  title: string;
  /** Absolute path of the project (git root of the agent's working directory) the session belongs to. */
  projectPath?: string;
  /** The directory the agent was started in, when it differs from `projectPath` (used to resume sessions). */
  cwd?: string;
  model?: string;
  /** Version of the agent that wrote the session, when recorded (helps diagnose format changes). */
  agentVersion?: string;
  status: SessionStatus;
  /** Why the session is in its status, e.g. "Needs approval: Bash". */
  statusDetail?: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds of the last observed activity. */
  updatedAt: number;
  tasks: TaskItem[];
  activity?: Activity;
  /** The current (or last) turn: tool calls since the user's last prompt. A progress signal even without a plan. */
  turn?: { steps: number; startedAt: number };
  /** The task in progress: when it started, actions taken on it, and the plan's typical task duration. */
  current?: { taskId: string; startedAt: number; steps: number; typicalMs?: number };
  /** The agent's latest actions, newest first. */
  recent?: Activity[];
  /** Set while the agent reports an API or connection problem, e.g. while retrying. */
  trouble?: { message: string; at: number; attempt?: number; maxAttempts?: number };
  /** `undefined` means the agent does not expose token usage locally. */
  tokens?: TokenUsage;
  /** Estimated cost at API list prices. `undefined` when pricing is unknown. */
  costUsd?: number;
  /** Usage bucketed by local calendar day (`YYYY-MM-DD`). */
  daily?: Record<string, DailyUsage>;
  context?: { used: number; window?: number };
  rateLimits?: RateLimitWindow[];
  /** Number of subagents that were active recently. */
  activeSubagents?: number;
  turns?: number;
  /** Files the session was read from (for "open transcript"). */
  sources: string[];
}

export interface Snapshot {
  generatedAt: number;
  sessions: AgentSession[];
  /** Per-agent errors, surfaced in the UI instead of crashing it. */
  errors: { agent: AgentId; message: string }[];
}

/** Whether Kvali's hooks are present in an agent's settings. */
export type HookStatus = 'installed' | 'outdated' | 'not-installed';

export interface Progress {
  done: number;
  inProgress: number;
  total: number;
  /** 0–100, or `undefined` when the session has no plan. */
  percent?: number;
}

export function totalTokens(t: TokenUsage | undefined): number {
  if (!t) return 0;
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function progressOf(tasks: readonly TaskItem[]): Progress {
  let done = 0;
  let inProgress = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
    total += 1;
    if (t.status === 'completed') done += 1;
    else if (t.status === 'in_progress') inProgress += 1;
  }
  return { done, inProgress, total, percent: total ? Math.round((done / total) * 100) : undefined };
}

export function currentTask(tasks: readonly TaskItem[]): TaskItem | undefined {
  return tasks.find((t) => t.status === 'in_progress');
}

/** Sort weight: what needs attention first. */
export const STATUS_PRIORITY: Record<SessionStatus, number> = {
  waiting: 0,
  working: 1,
  error: 2,
  idle: 3,
  done: 4,
  stale: 5,
};

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addTokens(into: TokenUsage, add: TokenUsage): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  into.reasoning = (into.reasoning ?? 0) + (add.reasoning ?? 0);
}
