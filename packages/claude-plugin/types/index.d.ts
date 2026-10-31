/** A step of the agent's plan (Claude Code Tasks or TodoWrite). */
export type KvTask = {
  id: string
  title: string
  /** The present-tense form shown while the step runs ("Writing tests"). */
  active?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** The step in progress: when it started and how many actions it took so far. */
export type KvStep = { key: string; startedAt: number; actions: number }

export type KvPlan = {
  tasks: KvTask[]
  step?: KvStep
  /** How long finished steps took, seen live. */
  durations: number[]
  /** The same, estimated from the task files' times (covers a plan made before Kvali loaded). */
  fileDurations: number[]
}

/**
 * What the agent is doing, from the engine's own events, so nothing here is a guess:
 * the model's stream (thinking, writing, writing a tool call), a tool running, a
 * question or permission waiting for the person, the turn's end.
 */
export type KvPhase =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'writing'
  | 'tool-input'
  | 'running'
  | 'needs-you'
  | 'stalled'
  | 'done'
  | 'interrupted'
  | 'error'
  | 'ended'

export type KvLive = {
  phase: KvPhase
  /** When this phase began. */
  since: number
  turnStartedAt?: number
  /** The last piece of the model's response that arrived. */
  lastDataAt?: number
  label?: string
  detail?: string
  lastTurnMs?: number
}

/** A tool call, for the "latest actions" list. */
export type KvAction = {
  id: string
  label: string
  detail?: string
  startedAt: number
  endedAt?: number
  isError?: boolean
}

export type KvUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Tokens the last main request sent: how full the context window is. */
  context?: number
  model?: string
  /** False when only the requests since Kvali loaded are counted. */
  isWholeSession: boolean
}

declare module 'claude-code' {
  interface PluginState {
    kvali: {
      plan: Shaped<KvPlan>
      live: Shaped<KvLive>
      recent: Shaped<KvAction[]>
      usage: Shaped<KvUsage>
      showTasks: boolean
    }
  }
}
