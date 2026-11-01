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

export type PhoneEvent = 'needs-you' | 'done' | 'error' | 'stuck' | 'steps' | 'actions'
/** `doneAfterSec`: a turn's end is pushed when it took at least this long (0: every turn), or when the phone followed it. */
export type PhoneCfg = { server: string; topic: string; token?: string; events: PhoneEvent[]; details: boolean; doneAfterSec: number }
const PHONE_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'steps', 'actions', 'error', 'stuck']
const DEFAULT_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps']

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
  if (typeof r.topic !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.topic)) return undefined
  const server = typeof r.server === 'string' && /^https?:\/\/[^\s/]/.test(r.server) ? r.server.replace(/\/+$/, '') : 'https://ntfy.sh'
  let events = Array.isArray(r.events) ? r.events.filter((e): e is PhoneEvent => PHONE_EVENTS.includes(e as PhoneEvent)) : [...DEFAULT_EVENTS]
  const v1Default = events.length === DEFAULT_EVENTS_V1.length && DEFAULT_EVENTS_V1.every(e => events.includes(e))
  if (r.v === undefined && v1Default) events = [...DEFAULT_EVENTS]
  const doneAfterSec = typeof r.doneAfter === 'number' && Number.isFinite(r.doneAfter) && r.doneAfter >= 0 ? Math.min(Math.round(r.doneAfter), 86_400) : 120
  return { server, topic: r.topic, token: typeof r.token === 'string' && r.token ? r.token : undefined, events, details: r.details !== false, doneAfterSec }
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
export type PushKind = 'needs-you' | 'finished' | 'paused' | 'error' | 'stalled' | 'step'

/** The words of a push, the same as the extension's. Without details no project or step names leave the computer. */
export function phonePush(
  kind: PushKind,
  info: { project: string; plan: KvPlan; label?: string; workedMs?: number; tokens?: number; quietMs?: number; doing?: string },
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
    case 'step':
    {
      // The turn's live notification: the plan's progress and, when chosen, the action running now.
      const next = step ? undefined : info.plan.tasks.find(t => t.status === 'pending')?.title
      const line = details ? (step ? `Now: ${truncate(step, 120)}` : next ? `Next: ${truncate(next, 120)}` : undefined) : undefined
      const doing = details && info.doing ? `Doing: ${truncate(info.doing, 120)}` : undefined
      return {
        title: p.total ? `Claude Code${where} · ${p.done}/${p.total}` : `Claude Code${where} · working`,
        message: lines(p.total ? `${phoneBar(p.done, p.total)} ${p.percent}%` : undefined, line, doing) || 'Working',
        priority: 2,
        tags: ['arrow_forward'],
      }
    }
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
  '(or TodoWrite), keep exactly one task in_progress, and mark each task completed as soon as it is done. ' +
  'The user follows your progress from that list, so keep it current.'

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
