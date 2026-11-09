// Pure logic of the Kvali mod: no `$`, so the tests can call it directly.

import type { KvAction, KvLive, KvPhase, KvPlan, KvTask, KvUsage } from '../types'

/** No piece of the response for this long while a request is open: say so (a fact, not a guess). */
export const STALL_MS = 90_000
/** Completions closer than this are one batch update, not a step's duration. */
const BATCH_MS = 10_000

export const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

/** Tools whose call waits for the person while it runs. */
export const ASKS_PERSON: Record<string, string> = {
  AskUserQuestion: 'Claude asked you a question',
  ExitPlanMode: 'A plan is waiting for your approval',
}

/** What a `tool.check` verdict says stands behind an ask. */
export type AskVerdict = { plugin?: string; hook?: string; rule?: string; setting?: string; ceiling?: string }

/**
 * Whether the engine's `ask` for a tool call is put to the person. A hook's ask (`plugin`) always
 * is. The engine's own asks go to the permission mode's decider: in `dontAsk` they are refused, in
 * `auto` a classifier approves or blocks them, except those auto mode still shows the person: a
 * settings hook's (`hook`), an explicit ask rule's (`rule`), an option's own check (`setting`) and
 * a connector tool the organization keeps at `ask`. A mode not known yet counts as one that asks.
 */
export function asksPerson(verdict: AskVerdict, mode: string | undefined): boolean {
  if (verdict.plugin) return true
  if (mode === 'dontAsk') return false
  if (mode !== 'auto') return true
  return Boolean(verdict.hook || verdict.rule || verdict.setting) || verdict.ceiling === 'ask'
}

export const EMPTY_PLAN: KvPlan = { tasks: [], durations: [], fileDurations: [] }
export const EMPTY_USAGE: KvUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, isWholeSession: false }
export const IDLE: KvLive = { phase: 'idle', since: 0 }

export const keyOf = (t: KvTask): string => t.title.trim().toLowerCase() || `#${t.id}`

export function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2
}

export function progress(tasks: readonly KvTask[]) {
  const total = tasks.length
  const done = tasks.filter(t => t.status === 'completed').length
  const inProgress = tasks.filter(t => t.status === 'in_progress').length
  const current = tasks.find(t => t.status === 'in_progress')
  return { total, done, inProgress, percent: total ? Math.round((done / total) * 100) : 0, current }
}

/** How long a step of this plan usually takes: the larger sample wins. */
export function typicalMs(plan: KvPlan): number | undefined {
  return median(plan.durations.length >= plan.fileDurations.length ? plan.durations : plan.fileDurations)
}

/**
 * How long the rest of the plan should take at its own pace: the typical step for each step
 * left, less the time already spent on the current one. Undefined until a step has finished.
 */
export function planEtaMs(plan: KvPlan, now: number): number | undefined {
  const typical = typicalMs(plan)
  if (!typical) return undefined
  const p = progress(plan.tasks)
  const left = p.total - p.done
  if (!p.total || left <= 0) return undefined
  const spent = p.current && plan.step ? Math.max(0, now - plan.step.startedAt) : 0
  return Math.max(0, typical - spent) + (left - 1) * typical
}

/** One usage window as Claude Code reports it (`session.measure`, `$.session.usage()`). */
export type LimitWindow = { kind: string; percentUsed: number; resetsAt?: string }
/** Each window's readings over the last hour and a half (`[at, percent]`), within its current period. */
export type LimitSamples = Record<string, { resetsAt?: string; points: [number, number][] }>

const LIMIT_KEEP_MS = 90 * 60_000
const LIMIT_PACE_MS = 60 * 60_000

const sameReset = (a?: string, b?: string): boolean => !a || !b || Math.abs(Date.parse(a) - Date.parse(b)) <= 5 * 60_000

/** Adds a reading of each window: a new value, or the same one again after five minutes. A window that reset starts over. */
export function addLimitSamples(prev: LimitSamples, windows: readonly LimitWindow[], now: number): LimitSamples {
  const out: LimitSamples = {}
  for (const w of windows) {
    if (typeof w?.kind !== 'string' || typeof w.percentUsed !== 'number') continue
    const old = prev[w.kind]
    let points: [number, number][] = old && sameReset(old.resetsAt, w.resetsAt) ? old.points.filter(([at]) => now - at <= LIMIT_KEEP_MS) : []
    const last = points[points.length - 1]
    if (!last || last[1] !== w.percentUsed || now - last[0] >= 5 * 60_000) points = [...points, [now, w.percentUsed]]
    out[w.kind] = { resetsAt: w.resetsAt, points: points.slice(-40) }
  }
  return out
}

/** When a window is used up at the pace of the last hour, if that comes before it resets; the extension's forecast. */
export function limitRunsOut(points: readonly [number, number][], w: LimitWindow, now: number): number | undefined {
  const last = points[points.length - 1]
  if (!last) return undefined
  if (w.percentUsed >= 100) return last[0]
  if (now - last[0] > LIMIT_PACE_MS) return undefined
  const first = points.find(([at]) => at >= last[0] - LIMIT_PACE_MS)
  if (!first || last[0] - first[0] < 5 * 60_000) return undefined
  const rate = (last[1] - first[1]) / (last[0] - first[0])
  if (!(rate > 0)) return undefined
  const out = last[0] + (100 - last[1]) / rate
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  return Number.isFinite(reset) && out >= reset ? undefined : Math.round(out)
}

/** Claude Code's window kinds as short labels: `five_hour` 5h, `seven_day` weekly. */
export function limitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  const week = /^seven_day(?:_(\w+))?$/.exec(kind)
  if (week) return week[1] ? `weekly ${week[1]}` : 'weekly'
  return kind === 'spend_limit' ? 'spend' : kind.replace(/_/g, ' ')
}

/** "~20m left", "~1h 10m left", "under a minute left". */
export function fmtEta(ms: number): string {
  if (ms < 60_000) return 'under a minute left'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `~${m}m left`
  const h = Math.floor(m / 60)
  return m % 60 ? `~${h}h ${m % 60}m left` : `~${h}h left`
}

function normStatus(s: unknown): KvTask['status'] {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending'
}

/** One task file of Claude Code's Tasks (`<config>/tasks/<session>/<id>.json`). */
export function parseTaskFile(text: string, fallbackId: string): KvTask | undefined {
  try {
    const t = JSON.parse(text) as Record<string, unknown>
    if (t.status === 'deleted') return undefined
    return {
      id: String(t.id ?? fallbackId),
      title: String(t.subject ?? t.title ?? ''),
      active: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      status: normStatus(t.status),
    }
  } catch {
    return undefined
  }
}

export function sortTasks(tasks: KvTask[]): KvTask[] {
  return tasks.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
}

/**
 * Applies a plan tool call to the task list. `input` is the call's arguments,
 * `result` the tool's structured result (TaskCreate answers the new id).
 */
export function applyPlanTool(tasks: readonly KvTask[], tool: string, input: Record<string, unknown>, result: unknown): KvTask[] {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return (input.todos as Record<string, unknown>[]).map((t, i) => ({
      id: `todo-${i + 1}`,
      title: String(t.content ?? ''),
      active: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      status: normStatus(t.status),
    }))
  }
  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
    if (task?.id === undefined) return [...tasks]
    const id = String(task.id)
    if (tasks.some(t => t.id === id)) return [...tasks]
    return sortTasks([
      ...tasks,
      { id, title: String(task.subject ?? input.subject ?? ''), active: typeof input.activeForm === 'string' ? input.activeForm : undefined, status: 'pending' },
    ])
  }
  if (tool === 'TaskUpdate' && input.taskId !== undefined) {
    const id = String(input.taskId)
    if (input.status === 'deleted') return tasks.filter(t => t.id !== id)
    return tasks.map(t =>
      t.id !== id
        ? t
        : {
            ...t,
            status: input.status === undefined ? t.status : normStatus(input.status),
            title: typeof input.subject === 'string' ? input.subject : t.title,
            active: typeof input.activeForm === 'string' ? input.activeForm : t.active,
          },
    )
  }
  return [...tasks]
}

/**
 * Moves the plan to a new task list: closes the step that finished (its time joins
 * `durations`) and starts timing the one now in progress. `fileTimes` (task id to the
 * mtime of its file) gives the true start of a step that began before Kvali saw it.
 */
export function advance(prev: KvPlan, tasks: KvTask[], now: number, fileTimes?: ReadonlyMap<string, number>): KvPlan {
  const durations = [...prev.durations]
  if (prev.step) {
    const before = prev.tasks.find(t => keyOf(t) === prev.step!.key)
    const after = tasks.find(t => keyOf(t) === prev.step!.key)
    if (after?.status === 'completed' && before?.status !== 'completed' && now >= prev.step.startedAt) {
      durations.push(now - prev.step.startedAt)
    }
  }
  const cur = tasks.find(t => t.status === 'in_progress')
  let step = prev.step
  if (!cur) step = undefined
  else {
    const fileStart = fileTimes?.get(cur.id)
    if (!step || step.key !== keyOf(cur)) step = { key: keyOf(cur), startedAt: fileStart !== undefined ? Math.min(fileStart, now) : now, actions: 0 }
    else if (fileStart !== undefined && fileStart < step.startedAt) step = { ...step, startedAt: fileStart }
  }
  let fileDurations = prev.fileDurations
  if (fileTimes) {
    const done = tasks
      .filter(t => t.status === 'completed')
      .map(t => fileTimes.get(t.id))
      .filter((x): x is number => x !== undefined)
      .sort((a, b) => a - b)
    fileDurations = []
    for (let i = 1; i < done.length; i += 1) if (done[i]! - done[i - 1]! >= BATCH_MS) fileDurations.push(done[i]! - done[i - 1]!)
  }
  return { tasks, step, durations: durations.slice(-50), fileDurations }
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

function relPath(p: unknown, cwd: string): string | undefined {
  if (typeof p !== 'string' || !p) return undefined
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1)
  return p
}

/** A short label and detail for a tool call, the way a person would say it. */
export function describeTool(tool: string, input: Record<string, unknown>, cwd: string): { label: string; detail?: string } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  switch (tool) {
    case 'Bash': {
      const cmd = str('command')
      const desc = str('description')
      return { label: desc ? truncate(desc, 60) : 'Run a command', detail: cmd ? truncate(cmd.split('\n')[0] ?? cmd, 80) : undefined }
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { label: tool, detail: relPath(input.file_path ?? input.notebook_path, cwd) }
    case 'Grep':
    case 'Glob':
      return { label: tool === 'Grep' ? 'Search' : 'Find files', detail: str('pattern') && truncate(str('pattern')!, 60) }
    case 'WebFetch':
      return { label: 'Read a web page', detail: str('url') && truncate(str('url')!, 70) }
    case 'WebSearch':
      return { label: 'Search the web', detail: str('query') && truncate(str('query')!, 70) }
    case 'Task':
    case 'Agent':
      return { label: 'Subagent', detail: str('description') && truncate(str('description')!, 70) }
    default: {
      if (PLAN_TOOLS.has(tool)) return { label: 'Updating the plan' }
      if (ASKS_PERSON[tool]) return { label: ASKS_PERSON[tool]! }
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (mcp) return { label: `${mcp[1]}: ${mcp[2]}` }
      return { label: tool }
    }
  }
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Minutes only, for places that should not change every second. */
export function fmtMinutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// ---------- going in circles: the same action failing the same way, again and again ----------

/** The same error this many times in a row is a loop; so are this many failures whatever their errors. */
const SAME_ERROR_RUNS = 4
const ANY_ERROR_RUNS = 8
const LOOP_FORGET_MS = 30 * 60_000

export type LoopStreak = { label: string; detail?: string; count: number; same: number; sig: string; since: number; last: number; tokens: number }
export type KvLoop = { label: string; detail?: string; count: number; sameError: boolean; since: number; tokensAtStart: number }

/** A short fingerprint of an error's last lines; numbers (times, counts, ports) do not count, the same as the extension's. */
export function errorSignature(text: string): string {
  const tail = text.slice(-600).toLowerCase().replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The key of an action: a command by its command line, a file tool by its file. */
export const loopKey = (tool: string, d: { label: string; detail?: string }): string => (tool === 'Bash' ? `command:${d.detail ?? d.label}` : `${tool}:${d.detail ?? ''}`)

/** One finished call: a failure lengthens its action's streak (the same error, or not), a success ends it. */
export function noteCall(streaks: Map<string, LoopStreak>, key: string, d: { label: string; detail?: string }, error: string | undefined, now: number, tokens: number): void {
  if (error === undefined) {
    streaks.delete(key)
    return
  }
  const sig = errorSignature(error)
  const s = streaks.get(key)
  if (!s || now - s.last > LOOP_FORGET_MS) {
    streaks.set(key, { label: d.label, detail: d.detail, count: 1, same: 1, sig, since: now, last: now, tokens })
    return
  }
  s.count += 1
  s.same = s.sig === sig ? s.same + 1 : 1
  s.sig = sig
  s.last = now
  s.label = d.label
}

/** The longest streak that counts as going in circles, if any. */
export function currentLoop(streaks: ReadonlyMap<string, LoopStreak>, now: number): KvLoop | undefined {
  let best: LoopStreak | undefined
  for (const s of streaks.values()) {
    if (now - s.last > LOOP_FORGET_MS || (s.same < SAME_ERROR_RUNS && s.count < ANY_ERROR_RUNS)) continue
    if (!best || s.count > best.count) best = s
  }
  return best ? { label: best.label, detail: best.detail, count: best.count, sameError: best.same >= SAME_ERROR_RUNS, since: best.since, tokensAtStart: best.tokens } : undefined
}

/** The text of a failed call's result, for its fingerprint. */
export function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? 'error'
  } catch {
    return 'error'
  }
}

/** A forecast, to the minute: "~30m", "~1h 05m". */
export function fmtAbout(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `~${m}m` : `~${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

export const totalTokens = (u: KvUsage): number => u.input + u.output + u.cacheRead + u.cacheWrite

/** The context window the last request filled: 1M for `[1m]` models or once a request went past 200k. */
export function contextPercent(u: KvUsage): number | undefined {
  if (!u.context) return undefined
  const window = /\[1m\]/i.test(u.model ?? '') || u.context > 200_000 ? 1_000_000 : 200_000
  return Math.min(100, Math.round((u.context / window) * 100))
}

/** A text progress bar: done, in progress, the rest. Text draws the same on every surface. */
export function barCells(done: number, inProgress: number, total: number, width: number): { done: string; active: string; rest: string } {
  const w = Math.max(4, Math.floor(width))
  if (!total) return { done: '', active: '', rest: '░'.repeat(w) }
  const d = Math.min(w, Math.round((done / total) * w))
  const a = Math.min(w - d, inProgress ? Math.max(1, Math.round((inProgress / total) * w)) : 0)
  return { done: '█'.repeat(d), active: '▒'.repeat(a), rest: '░'.repeat(Math.max(0, w - d - a)) }
}

export type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'muted'

/** The one-line answer to "is it working?", from what the engine reported. */
export function liveLine(live: KvLive, now: number): { icon: string; text: string; tone: Tone } {
  const for_ = fmtDuration(now - live.since)
  const what = live.label ? `“${live.label}”` : ''
  switch (live.phase) {
    case 'requesting':
      return { icon: '●', text: `Waiting for the model · ${for_}`, tone: 'ok' }
    case 'thinking':
      return { icon: '●', text: `Thinking · ${for_}`, tone: 'ok' }
    case 'writing':
      return { icon: '●', text: `Writing the answer · ${for_}`, tone: 'ok' }
    case 'tool-input':
      return { icon: '●', text: `Preparing ${live.label ?? 'a tool call'} · ${for_}`, tone: 'ok' }
    case 'running':
      return { icon: '◌', text: `Running ${what || 'a tool'} · ${for_}`, tone: 'busy' }
    case 'needs-you':
      return { icon: '!', text: `Needs you: ${live.label ?? 'waiting for your answer'}`, tone: 'warn' }
    case 'stalled':
      return {
        icon: '⚠',
        text: `No data from the API for ${fmtDuration(now - (live.lastDataAt ?? live.since))}. The connection may be down; Claude Code retries on its own.`,
        tone: 'warn',
      }
    case 'done':
      return { icon: '✓', text: live.lastTurnMs ? `Done in ${fmtDuration(live.lastTurnMs)}` : 'Done', tone: 'ok' }
    case 'interrupted':
      return { icon: '■', text: 'Stopped by you', tone: 'muted' }
    case 'error':
      return { icon: '✕', text: `Stopped: ${live.label ?? 'an API error ended the turn'}`, tone: 'error' }
    case 'ended':
      return { icon: '○', text: 'Session ended', tone: 'muted' }
    default:
      return { icon: '○', text: 'Idle', tone: 'muted' }
  }
}

export function isActivePhase(p: KvPhase): boolean {
  return p !== 'idle' && p !== 'done' && p !== 'interrupted' && p !== 'error' && p !== 'ended'
}

/** The status line text: short, and it changes only when something real changes. */
export function statusText(plan: KvPlan, live: KvLive, now: number): string | undefined {
  const p = progress(plan.tasks)
  const step = p.current ? truncate(p.current.active ?? p.current.title, 32) : undefined
  const head = p.total ? `${p.done}/${p.total} · ${p.percent}%` : undefined
  const active = isActivePhase(live.phase)
  const state = (() => {
    switch (live.phase) {
      case 'needs-you':
        return 'needs you'
      case 'stalled':
        return '⚠ no data from the API'
      case 'running':
        return `running ${fmtMinutes(now - live.since)}`
      case 'requesting':
      case 'thinking':
      case 'writing':
      case 'tool-input':
        return live.phase === 'writing' ? 'writing' : 'thinking'
      case 'error':
        return 'stopped: error'
      default:
        return undefined
    }
  })()
  if (!head && !active) return undefined
  return ['Kvali', head, step, state].filter(Boolean).join(' · ')
}

/** Keeps the latest actions, newest first. */
export function pushAction(list: readonly KvAction[], a: KvAction, max = 6): KvAction[] {
  return [a, ...list.filter(x => x.id !== a.id)].slice(0, max)
}

export function endAction(list: readonly KvAction[], id: string, at: number, isError: boolean): KvAction[] {
  return list.map(x => (x.id === id ? { ...x, endedAt: at, isError: isError || undefined } : x))
}

/**
 * Reads what Kvali missed before it loaded from a Claude Code transcript: the tokens
 * spent (once per API response; Claude Code repeats the usage on every block's line)
 * and the last TodoWrite list, for sessions that plan without the Tasks tools.
 */
export function scanTranscript(text: string): { usage: KvUsage; todos?: KvTask[] } {
  const seen = new Set<string>()
  const u: KvUsage = { ...EMPTY_USAGE, isWholeSession: true }
  let todos: KvTask[] | undefined
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"assistant"')) continue
    let r: Record<string, any>
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const m = r.message
    if (r.type !== 'assistant' || !m) continue
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use' && b.name === 'TodoWrite' && !r.isSidechain) todos = applyPlanTool([], 'TodoWrite', b.input ?? {}, undefined)
    }
    if (!m.usage) continue
    const key = `${m.id ?? ''}:${r.requestId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    u.input += m.usage.input_tokens ?? 0
    u.output += m.usage.output_tokens ?? 0
    u.cacheRead += m.usage.cache_read_input_tokens ?? 0
    u.cacheWrite += m.usage.cache_creation_input_tokens ?? 0
    if (!r.isSidechain && m.model !== '<synthetic>') {
      u.context = (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0)
      if (typeof m.model === 'string') u.model = m.model
    }
  }
  return { usage: u, todos }
}

/** Claude Code's folder name for a project: every character but letters and digits becomes `-`. */
export const projectSlug = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-')

// ---------- phone notifications (shared setup in ~/.kvali/config.json) ----------

export type PhoneEvent = 'needs-you' | 'done' | 'error' | 'stuck' | 'steps' | 'actions' | 'limits'
/** `doneAfterSec`: a turn's end is pushed when it took at least this long (0: every turn), or when the phone followed it. */
export type PhoneCfg = {
  server: string
  /** The ntfy topic; absent when only Telegram or Discord receives the notifications. */
  topic?: string
  token?: string
  telegram?: { token: string; chatId: string }
  discord?: { webhook: string }
  events: PhoneEvent[]
  details: boolean
  doneAfterSec: number
}
const PHONE_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'steps', 'actions', 'error', 'stuck', 'limits']
const DEFAULT_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps', 'limits']
/** Kvali 0.6's default, before limits: it reads as today's default. */
const DEFAULT_EVENTS_V2: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps']

/** Kvali 0.5 saved this list as its default, before progress existed: it reads as today's default. */
const DEFAULT_EVENTS_V1: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck']

/** The `phone` section of Kvali's config file, as the editor extension and the CLI write it. */
export function parsePhoneConfig(text: string): PhoneCfg | undefined {
  let r: Record<string, unknown>
  try {
    r = (JSON.parse(text) as { phone?: Record<string, unknown> })?.phone ?? {}
  } catch {
    return undefined
  }
  const topic = typeof r.topic === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.topic) ? r.topic : undefined
  const tg = r.telegram && typeof r.telegram === 'object' ? (r.telegram as Record<string, unknown>) : undefined
  const chatId = typeof tg?.chatId === 'number' ? String(tg.chatId) : tg?.chatId
  const telegram =
    tg && typeof tg.token === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(tg.token) && typeof chatId === 'string' && /^-?\d{1,20}$/.test(chatId)
      ? { token: tg.token, chatId }
      : undefined
  const hook = r.discord && typeof r.discord === 'object' ? (r.discord as Record<string, unknown>).webhook : undefined
  const discord =
    typeof hook === 'string' && /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/.test(hook) ? { webhook: hook } : undefined
  if (!topic && !telegram && !discord) return undefined
  const server = typeof r.server === 'string' && /^https?:\/\/[^\s/]/.test(r.server) ? r.server.replace(/\/+$/, '') : 'https://ntfy.sh'
  let events = Array.isArray(r.events) ? r.events.filter((e): e is PhoneEvent => PHONE_EVENTS.includes(e as PhoneEvent)) : [...DEFAULT_EVENTS]
  const same = (list: readonly PhoneEvent[]) => events.length === list.length && list.every(e => events.includes(e))
  if ((r.v === undefined && same(DEFAULT_EVENTS_V1)) || (r.v === 2 && same(DEFAULT_EVENTS_V2))) events = [...DEFAULT_EVENTS]
  const doneAfterSec = typeof r.doneAfter === 'number' && Number.isFinite(r.doneAfter) && r.doneAfter >= 0 ? Math.min(Math.round(r.doneAfter), 86_400) : 120
  return {
    server,
    ...(topic ? { topic } : {}),
    token: typeof r.token === 'string' && r.token ? r.token : undefined,
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {}),
    events,
    details: r.details !== false,
    doneAfterSec,
  }
}

/** Silent updates pause while fewer messages than this are left for the day, so alerts still get through. */
export const QUIET_RESERVE = 50

/** Messages left for today from ntfy's `GET /v1/account`, when the server limits them (ntfy.sh: 250 a day per address). */
export function messagesLeftOf(text: string): number | undefined {
  try {
    const a = JSON.parse(text) as { limits?: { messages?: number }; stats?: { messages_remaining?: number } }
    const limit = a?.limits?.messages
    const left = a?.stats?.messages_remaining
    return typeof limit === 'number' && limit > 0 && typeof left === 'number' ? left : undefined
  } catch {
    return undefined
  }
}

/** `sequence`: the notification it replaces (ntfy's sequence ID), so a turn's progress and its end are one notification. */
export type PhonePush = { title: string; message: string; priority: 2 | 3 | 4; tags: string[]; sequence?: string }
export type PushKind = 'needs-you' | 'finished' | 'paused' | 'error' | 'stalled' | 'loop' | 'step'

/** The words of a push, the same as the extension's. Without details no project or step names leave the computer. */
export function phonePush(
  kind: PushKind,
  info: { project: string; plan: KvPlan; label?: string; workedMs?: number; tokens?: number; quietMs?: number; doing?: string; etaMs?: number; loop?: { what: string; count: number; sameError: boolean; forMs: number; tokens?: number } },
  details: boolean,
): PhonePush {
  const where = details && info.project ? ` · ${info.project}` : ''
  const p = progress(info.plan.tasks)
  const step = p.current ? (p.current.active ?? p.current.title) : undefined
  const planLine = p.total ? `${p.done}/${p.total} tasks${details && step ? ` · ${truncate(step, 80)}` : ''}` : undefined
  const lines = (...xs: (string | undefined)[]) => xs.filter(Boolean).join('\n')
  switch (kind) {
    case 'needs-you':
      return { title: `Claude Code needs you${where}`, message: lines(details && info.label ? truncate(info.label, 200) : 'Waiting for your answer', planLine), priority: 4, tags: ['bell'] }
    case 'finished': {
      const facts = [info.workedMs ? `in ${fmtDuration(info.workedMs)}` : undefined, p.total ? `${p.done}/${p.total} tasks` : undefined, info.tokens ? `${fmtTokens(info.tokens)} tokens` : undefined]
        .filter(Boolean)
        .join(' · ')
      return { title: `Claude Code finished${where}`, message: facts ? `Done ${facts}` : 'Done', priority: 3, tags: ['white_check_mark'] }
    }
    case 'paused':
      return { title: `Claude Code stopped and is waiting for you${where}`, message: planLine ? `Stopped at ${planLine}` : 'Its turn ended before the plan was done', priority: 4, tags: ['raised_hand'] }
    case 'error':
      return { title: `Claude Code stopped with an error${where}`, message: lines(details && info.label ? info.label : 'The turn ended with an error', planLine), priority: 4, tags: ['x'] }
    case 'stalled':
      return {
        title: `Claude Code: no data from the API${where}`,
        message: `Nothing has arrived for ${fmtDuration(info.quietMs ?? STALL_MS)} while it was answering. The connection may be down; Claude Code retries on its own.`,
        priority: 3,
        tags: ['warning'],
      }
    case 'loop': {
      const l = info.loop
      const what = l ? (details ? `“${truncate(l.what, 80)}”` : 'The same action') : 'An action'
      const facts = l ? [`failed ${l.count} times in a row${l.sameError ? ' with the same error' : ''}`, `for ${fmtDuration(l.forMs)}`, l.tokens ? `${fmtTokens(l.tokens)} tokens` : undefined] : ['keeps failing']
      return { title: `Claude Code is going in circles${where}`, message: `${what} ${facts.filter(Boolean).join(' · ')}. It may need a hint from you.`, priority: 4, tags: ['repeat'] }
    }
    case 'step':
    {
      // The turn's live notification: the plan's progress and, when chosen, the action running now.
      const next = step ? undefined : info.plan.tasks.find(t => t.status === 'pending')?.title
      const line = details ? (step ? `Now: ${truncate(step, 120)}` : next ? `Next: ${truncate(next, 120)}` : undefined) : undefined
      const doing = details && info.doing ? `Doing: ${truncate(info.doing, 120)}` : undefined
      return {
        title: p.total ? `Claude Code${where} · ${p.done}/${p.total}` : `Claude Code${where} · working`,
        message: lines(p.total ? `${phoneBar(p.done, p.total)} ${p.percent}%${info.etaMs !== undefined ? ` · ${fmtEta(info.etaMs)}` : ''}` : undefined, line, doing) || 'Working',
        priority: 2,
        tags: ['arrow_forward'],
      }
    }
  }
}

const TAG_EMOJI: Record<string, string> = {
  white_check_mark: '✅',
  bell: '🔔',
  x: '❌',
  raised_hand: '✋',
  warning: '⚠️',
  hourglass: '⏳',
  hourglass_flowing_sand: '⏳',
  repeat: '🔁',
  arrow_forward: '▶️',
}
const emojiOf = (push: PhonePush): string | undefined => push.tags.map(t => TAG_EMOJI[t]).find(Boolean)
const escapeHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A push as a Telegram message (HTML): bold title, the message below it; the same as the extension's. */
export function telegramText(push: PhonePush): string {
  const emoji = emojiOf(push)
  return `${emoji ? `${emoji} ` : ''}<b>${escapeHtml(push.title)}</b>${push.message ? `\n${escapeHtml(push.message)}` : ''}`
}

/** Discord embed colors by what happened. */
export const PUSH_COLOR: Record<PushKind, number> = {
  'needs-you': 0xd29922,
  finished: 0x3fb950,
  paused: 0xd29922,
  error: 0xf85149,
  stalled: 0xdb6d28,
  loop: 0xdb6d28,
  step: 0x58a6ff,
}

/** A push as a Discord webhook message: one embed; silent updates do not notify. */
export function discordBody(push: PhonePush, color: number): Record<string, unknown> {
  const emoji = emojiOf(push)
  return {
    username: 'Kvali',
    allowed_mentions: { parse: [] },
    embeds: [{ title: `${emoji ? `${emoji} ` : ''}${push.title}`.slice(0, 256), description: push.message.slice(0, 4_000), color }],
    ...(push.priority <= 2 ? { flags: 4_096 } : {}),
  }
}

export function ntfyBody(cfg: PhoneCfg, push: PhonePush): string {
  return JSON.stringify({ topic: cfg.topic, title: push.title, message: push.message, priority: push.priority, tags: push.tags, ...(push.sequence ? { sequence_id: push.sequence } : {}) })
}

/** A text progress bar that reads on any phone, the same as the extension's: `███░░░░░░░`. */
export function phoneBar(done: number, total: number, cells = 10): string {
  const filled = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

/** The ntfy sequence ID of one turn's notification: letters, digits and `-` only. */
export function turnSequence(sessionId: string, startedAt: number): string {
  return `kvali-${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'session'}-${Math.max(0, Math.floor(startedAt)).toString(36)}`
}

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/** Sent beside a prompt while the session has no unfinished plan: the same words as Kvali's hook. */
export const PLAN_CONTEXT =
  'Progress tracking (Kvali): if this request takes more than two steps, start by creating a task list with TaskCreate ' +
  'or TodoWrite, whichever you have (if neither is in your tool list, look for them once with ToolSearch, and go on ' +
  'without a list if they are not there), keep exactly ' +
  'one task in_progress, and mark each task completed as soon as it is done. ' +
  'The user follows your progress from that list, so keep it current.'

/** Tool calls into a turn with no plan before Kvali asks for one beside a result, once a turn. */
export const PLAN_ASK_AFTER = 6

/** What a long turn with no plan reads after one of its tool results (once a turn). */
export const PLAN_REMINDER =
  'Progress tracking (Kvali): this work has no task list yet. If more than two steps remain, create one now for the ' +
  'steps left with TaskCreate or TodoWrite, whichever you have (if neither is in your tool list, look for them once ' +
  'with ToolSearch, and go on without a list if they are not there), ' +
  'keep one task in_progress, and mark each completed as you finish it. The user follows your progress from that list.'

/** `autoPlan` in Kvali's config file; on unless set to false. */
export function autoPlanEnabled(text: string | undefined): boolean {
  if (!text) return true
  try {
    return (JSON.parse(text) as { autoPlan?: unknown })?.autoPlan !== false
  } catch {
    return true
  }
}

/** Whether a prompt should carry the planning reminder. */
export function wantsPlanContext(plan: KvPlan): boolean {
  const p = progress(plan.tasks)
  return !(p.total > 0 && p.done < p.total)
}
