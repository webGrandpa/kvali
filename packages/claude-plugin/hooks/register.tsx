import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KvAction, KvLive, KvPhase, KvPlan, KvTask } from '../types'
import {
  ASKS_PERSON,
  addLimitSamples,
  currentLoop,
  asksPerson,
  EMPTY_PLAN,
  EMPTY_USAGE,
  IDLE,
  PLAN_TOOLS,
  STALL_MS,
  advance,
  applyPlanTool,
  baseName,
  autoPlanEnabled,
  ntfyBody,
  parsePhoneConfig,
  PUSH_COLOR,
  discordBody,
  telegramText,
  PLAN_CONTEXT,
  PLAN_ASK_AFTER,
  PLAN_REMINDER,
  wantsPlanContext,
  phonePush,
  barCells,
  contextPercent,
  describeTool,
  endAction,
  fmtAbout,
  fmtDuration,
  fmtEta,
  fmtMinutes,
  fmtTokens,
  isActivePhase,
  limitLabel,
  limitRunsOut,
  liveLine,
  loopKey,
  noteCall,
  parseTaskFile,
  planEtaMs,
  progress,
  projectSlug,
  resultText,
  pushAction,
  scanTranscript,
  sortTasks,
  statusText,
  totalTokens,
  turnSequence,
  typicalMs,
  messagesLeftOf,
  QUIET_RESERVE,
  type LimitSamples,
  type LimitWindow,
  type LoopStreak,
  type PhoneCfg,
  type PhonePush,
  type PushKind,
} from './model'

type Engine = EngineInterface

const PANE = 'kvali'
const TICK_MS = 2_000
const PULSE_EVERY_MS = 10_000
const LONG_TURN_MS = 120_000
/** Every background agent is done and nothing woke the session in this time: the task is over. */
const HELD_RELEASE_MS = 30_000
/** A question to the person is worth a push only after this long unanswered: sooner, they were at the computer. */
const ASK_PUSH_AFTER_MS = 60_000
/** `$.fs.read` copies at most 4 MiB into the plugin. */
const MAX_TRANSCRIPT = 4 * 1024 * 1024

// Change a tag when that value's fields change: a reload declines what an older version stored.
const plan = atom({ plugin: 'kvali', key: 'plan' } as const, EMPTY_PLAN, { shape: 'plan-1' })
const live = atom({ plugin: 'kvali', key: 'live' } as const, IDLE, { shape: 'live-1' })
const recent = atom({ plugin: 'kvali', key: 'recent' } as const, [] as KvAction[], { shape: 'recent-1' })
const usage = atom({ plugin: 'kvali', key: 'usage' } as const, EMPTY_USAGE, { shape: 'usage-1' })
const showTasks = atom({ plugin: 'kvali', key: 'showTasks' } as const, false)

type Running = {
  label: string
  detail?: string
  startedAt: number
  /** The subagent whose call it is; absent for the main loop's. */
  agent?: string
  asks?: string
  /** The same question for a phone push: no command text leaves the computer. */
  askPush?: string
  askedAt?: number
  /** The engine asked about this call and auto mode's classifier answers: the person only if a prompt follows. */
  review?: true
}
type StreamPhase = 'requesting' | 'thinking' | 'writing' | 'tool-input'

const quiet = <T,>(p: Promise<T>): void => {
  p.catch(() => undefined)
}

type Runtime = {
  running: Map<string, Running>
  stream: { phase: StreamPhase; since: number; label?: string } | undefined
  streamSeq: number
  seenSeq: number
  pendingPhase: { phase: StreamPhase; label?: string } | undefined
  lastDataAt: number
  turnActive: boolean
  turnStartedAt: number
  betweenSince: number
  ended: { phase: KvPhase; since: number; label?: string; lastTurnMs?: number } | undefined
  cwd: string
  sessionId: string
  tasksDir: string | undefined
  pulseFile: string | undefined
  lastPulseAt: number
  lastPulseKey: string
  lastLiveKey: string
  lastStatus: string | undefined
  /** Refreshes run one after another, so an older state never lands after a newer one. */
  refreshing: Promise<void>
  /** Phone notifications, set up in ~/.kvali/config.json by the extension or `kvali phone`. */
  phone: PhoneCfg | undefined
  phoneFile: string | undefined
  phoneCheckedAt: number
  project: string
  /** The episode (its `since`) each kind of push was last sent for: one push per event. */
  pushedNeedsFor: number
  pushedStallFor: number
  lastStepPushAt: number
  /** This turn's phone notification (an ntfy sequence ID): its progress updates and its end replace it. */
  turnSeq: string | undefined
  /** Tasks done when the last progress update went out, or when the turn began. */
  progressSentDone: number
  /** The tasks-done count last seen and since when: an update waits until it holds a moment. */
  progressSeenDone: number
  progressSeenAt: number
  /** The phone followed this turn's progress, so its end is sent however short the turn was. */
  progressSent: boolean
  /** A turn that stopped in the middle of its plan: pushed once it has waited like a question. */
  pendingPause: { at: number; workedMs: number; sequence?: string } | undefined
  /** The last live update (a step or an action) and the action it showed. */
  lastLivePushAt: number
  sentAction: string | undefined
  /** Messages the ntfy server still allows today (checked once a minute), to keep room for alerts. */
  budgetAt: number
  budgetLeft: number | undefined
  /** Ask Claude for a plan while there is none (`autoPlan` in ~/.kvali/config.json). */
  autoPlan: boolean
  /** Tool calls of the main loop in this turn, and whether this turn was already asked for a plan. */
  turnCalls: number
  planAsked: boolean
  /** The prompt just submitted carried the plan request: the turn it starts was asked. */
  promptAsked: boolean
  /** The session's permission mode, as the last classic event carried it: who answers an ask. */
  mode: string | undefined
  /** Agents the main loop started in the background, at work until their run ends. */
  background: Map<string, { label: string; startedAt: number }>
  /** Agents whose run's end was heard: the engine's list may call one running a moment longer. */
  finished: Set<string>
  /**
   * A task whose answer handed work to background agents: its end (the phone, the toast) waits
   * for theirs and for the turn their reports start. `idleSince`: all done, and nothing woke it.
   */
  held: { startedAt: number; sequence?: string; followed: boolean; idleSince?: number } | undefined
  /** The subscription's usage windows as the last API response reported them, and their recent readings. */
  limits: { at: number; windows: LimitWindow[] } | undefined
  limitSamples: LimitSamples
  /** Actions of the main loop that keep failing the same way, and the loop (its start) last pushed. */
  loops: Map<string, LoopStreak>
  pushedLoopFor: number
  /** Telegram and Discord message ids of the latest turns' notifications, to update them in place. */
  telegramIds: Map<string, number>
  discordIds: Map<string, string>
}

const fresh = (): Runtime => ({
  running: new Map(),
  stream: undefined,
  streamSeq: 0,
  seenSeq: 0,
  pendingPhase: undefined,
  lastDataAt: 0,
  turnActive: false,
  turnStartedAt: 0,
  betweenSince: 0,
  ended: undefined,
  cwd: '',
  sessionId: '',
  tasksDir: undefined,
  pulseFile: undefined,
  lastPulseAt: 0,
  lastPulseKey: '',
  lastLiveKey: '',
  lastStatus: undefined,
  refreshing: Promise.resolve(),
  phone: undefined,
  phoneFile: undefined,
  phoneCheckedAt: 0,
  project: '',
  pushedNeedsFor: 0,
  pushedStallFor: 0,
  lastStepPushAt: 0,
  turnSeq: undefined,
  progressSentDone: 0,
  progressSeenDone: 0,
  progressSeenAt: 0,
  progressSent: false,
  pendingPause: undefined,
  lastLivePushAt: 0,
  sentAction: undefined,
  budgetAt: -Infinity,
  budgetLeft: undefined,
  autoPlan: true,
  turnCalls: 0,
  planAsked: false,
  promptAsked: false,
  mode: undefined,
  background: new Map(),
  finished: new Set(),
  held: undefined,
  limits: undefined,
  limitSamples: {},
  loops: new Map(),
  pushedLoopFor: 0,
  telegramIds: new Map(),
  discordIds: new Map(),
})

/** Marks a call as waiting for the person's permission. */
function markAsk(r: Running, now: number): void {
  r.asks = `allow ${r.label}${r.detail ? ` (${r.detail})` : ''}?`
  r.askPush = `allow ${r.label}?`
  r.askedAt = now
}

/**
 * What happens right now, from the engine's events. It lives with the module: a reload
 * starts it over and the engine's next event fills it in again.
 */
let rt: Runtime = fresh()

function derive(now: number): KvLive {
  const base = { turnStartedAt: rt.turnActive ? rt.turnStartedAt : undefined, lastDataAt: rt.lastDataAt || undefined }
  const all = [...rt.running.values()]
  const asking = all.filter(r => r.asks).pop()
  if (asking) return { ...base, phase: 'needs-you', since: asking.askedAt ?? asking.startedAt, label: asking.asks }
  // The turn is over and agents it started work on: they are what runs.
  if (!rt.turnActive && rt.background.size) {
    const n = rt.background.size
    const since = Math.min(...[...rt.background.values()].map(b => b.startedAt))
    return { ...base, phase: 'running', since, label: `${n} background agent${n > 1 ? 's' : ''}` }
  }
  const last = all.pop()
  if (last) return { ...base, phase: 'running', since: last.startedAt, label: last.label, detail: last.detail }
  if (rt.stream) {
    const quietFrom = Math.max(rt.lastDataAt, rt.stream.since)
    if (now - quietFrom > STALL_MS) return { ...base, phase: 'stalled', since: quietFrom, lastDataAt: quietFrom }
    return { ...base, phase: rt.stream.phase, since: rt.stream.since, label: rt.stream.label }
  }
  if (rt.turnActive) return { ...base, phase: 'requesting', since: rt.betweenSince || rt.turnStartedAt }
  if (rt.ended) return { phase: rt.ended.phase, since: rt.ended.since, label: rt.ended.label, lastTurnMs: rt.ended.lastTurnMs }
  return { phase: 'idle', since: now }
}

/** Brings the drawn state, the status line and the editor's heartbeat file up to date, in order. */
function refresh($: Engine, force = false): Promise<void> {
  const run = rt.refreshing.then(() => doRefresh($, force))
  rt.refreshing = run.catch(() => undefined)
  return run
}

async function doRefresh($: Engine, force: boolean): Promise<void> {
  const now = await $.clock.now()
  if (rt.stream && rt.streamSeq !== rt.seenSeq) {
    rt.seenSeq = rt.streamSeq
    rt.lastDataAt = now
  }
  if (rt.stream && rt.pendingPhase && (rt.pendingPhase.phase !== rt.stream.phase || rt.pendingPhase.label !== rt.stream.label)) {
    rt.stream = { phase: rt.pendingPhase.phase, since: now, label: rt.pendingPhase.label }
  }
  if (rt.held?.idleSince !== undefined && !rt.turnActive && now - rt.held.idleSince >= HELD_RELEASE_MS) {
    const { startedAt, sequence, followed, idleSince } = rt.held
    rt.held = undefined
    rt.ended = { phase: 'done', since: idleSince, lastTurnMs: idleSince - startedAt }
    quiet(finish($, 'done', idleSince - startedAt, sequence, followed, now))
  }
  const l = derive(now)
  await loadPhone($, now)
  if (l.phase === 'needs-you' && rt.pushedNeedsFor !== l.since && now - l.since >= ASK_PUSH_AFTER_MS) {
    rt.pushedNeedsFor = l.since
    const asking = [...rt.running.values()].filter(r => r.asks).pop()
    quiet(push($, 'needs-you', { label: asking?.askPush ?? asking?.asks ?? l.label }))
  } else if (l.phase === 'stalled' && rt.pushedStallFor !== l.since) {
    rt.pushedStallFor = l.since
    quiet(push($, 'stalled', { quietMs: now - l.since }))
  }
  const loop = rt.turnActive ? currentLoop(rt.loops, now) : undefined
  if (loop && rt.pushedLoopFor !== loop.since) {
    rt.pushedLoopFor = loop.since
    const u = await read($, usage)
    quiet(push($, 'loop', { loop: { what: loop.detail ?? loop.label, count: loop.count, sameError: loop.sameError, forMs: now - loop.since, tokens: totalTokens(u) - loop.tokensAtStart || undefined } }))
  }
  if (rt.pendingPause && !rt.turnActive && now - rt.pendingPause.at >= ASK_PUSH_AFTER_MS) {
    const { workedMs, sequence } = rt.pendingPause
    rt.pendingPause = undefined
    quiet(push($, 'paused', { workedMs, sequence }))
  }
  const current = await read($, plan)
  const news = liveDue(current, now)
  if (news) quiet(push($, 'step', { sequence: turnSeq(now), doing: news.doing, etaMs: planEtaMs(current, now) }))
  const key = [l.phase, l.since, l.label ?? '', l.detail ?? ''].join('|')
  if (key !== rt.lastLiveKey || force) {
    rt.lastLiveKey = key
    await update($, live, () => l)
  }
  if (isActivePhase(l.phase)) $.ui.invalidate('ui.render')
  const status = statusText(current, l, now)
  if (status !== rt.lastStatus) {
    rt.lastStatus = status
    $.ui.status(status)
  }
  await pulse($, l, now, force)
}

/**
 * Progress on the phone: the turn's notification shows the latest finished step, at most
 * once a minute, so a step finished sooner goes out with the next refresh after that. A new
 * count waits a moment first: Claude marks a task done and the next one in progress in two
 * calls, and the update should name the next one.
 */
function liveDue(p: KvPlan, now: number): { doing?: string } | undefined {
  const pr = progress(p.tasks)
  if (pr.done < rt.progressSentDone) rt.progressSentDone = pr.done // a new plan
  if (pr.done !== rt.progressSeenDone) {
    rt.progressSeenDone = pr.done
    rt.progressSeenAt = now
  }
  const events = rt.phone?.events ?? []
  if (!rt.turnActive) return undefined
  const stepNews =
    events.includes('steps') &&
    pr.total > 0 &&
    pr.done > rt.progressSentDone &&
    pr.done < pr.total &&
    now - rt.lastStepPushAt >= 60_000 &&
    now - rt.progressSeenAt >= 1_500
  // With actions chosen: what runs now, at most twice a minute.
  const action = [...rt.running.values()].filter(r => !r.asks).pop()
  const actionKey = action ? `${action.label}|${action.startedAt}` : undefined
  const actionNews = events.includes('actions') && actionKey !== undefined && actionKey !== rt.sentAction && now - rt.lastLivePushAt >= 30_000
  if (!stepNews && !actionNews) return undefined
  rt.lastLivePushAt = now
  if (stepNews) {
    rt.lastStepPushAt = now
    rt.progressSentDone = pr.done
  }
  if (actionKey !== undefined) rt.sentAction = actionKey
  rt.progressSent = true
  return { doing: events.includes('actions') ? action?.label : undefined }
}

/** Silent updates are worth a message only while the day's allowance keeps room for alerts. */
async function quietAllowed($: Engine, cfg: PhoneCfg): Promise<boolean> {
  const now = await $.clock.now()
  if (now - rt.budgetAt >= 60_000) {
    rt.budgetAt = now
    rt.budgetLeft = undefined
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
    try {
      const res = await $.http.fetch(`${cfg.server}/v1/account`, { headers })
      if (res.ok) rt.budgetLeft = messagesLeftOf(res.text)
    } catch {
      // unknown: no limit to keep to
    }
  }
  return rt.budgetLeft === undefined || rt.budgetLeft > QUIET_RESERVE
}

function turnSeq(now: number): string {
  rt.turnSeq ??= turnSequence(rt.sessionId, rt.turnStartedAt || now)
  return rt.turnSeq
}

/**
 * The bridge to Kvali's editor extension and terminal dashboard: one small file per
 * session, rewritten while a turn runs. Its age is the proof of life: a working session
 * whose file stops changing was closed or froze, which nothing else can tell.
 */
async function pulse($: Engine, l: KvLive, now: number, force: boolean): Promise<void> {
  if (!rt.pulseFile) return
  const key = [l.phase, l.since, l.label ?? '', rt.background.size].join('|')
  const due = isActivePhase(l.phase) ? now - rt.lastPulseAt >= PULSE_EVERY_MS : false
  if (!force && key === rt.lastPulseKey && !due) return
  rt.lastPulseKey = key
  rt.lastPulseAt = now
  const p = await read($, plan)
  const pr = progress(p.tasks)
  const body = {
    v: 1,
    agent: 'claude-code',
    sessionId: rt.sessionId,
    at: now,
    push: rt.phone !== undefined,
    phase: l.phase,
    since: l.since,
    label: l.label,
    detail: l.detail,
    lastDataAt: l.lastDataAt,
    turnStartedAt: l.turnStartedAt,
    background: rt.background.size,
    limits: rt.limits
      ? { at: rt.limits.at, windows: rt.limits.windows, samples: Object.fromEntries(Object.entries(rt.limitSamples).map(([kind, v]) => [kind, v.points])) }
      : undefined,
    step: pr.current && p.step ? { title: pr.current.title, startedAt: p.step.startedAt, actions: p.step.actions, typicalMs: typicalMs(p) } : undefined,
  }
  try {
    await $.fs.write(rt.pulseFile, `${JSON.stringify(body)}\n`)
  } catch {
    rt.pulseFile = undefined // a read-only home: the pane still works
  }
}

async function taskFiles($: Engine): Promise<{ tasks: KvTask[]; times: Map<string, number> } | undefined> {
  if (!rt.tasksDir) return undefined
  let entries
  try {
    entries = await $.fs.list(rt.tasksDir)
  } catch {
    return undefined
  }
  const tasks: KvTask[] = []
  const times = new Map<string, number>()
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    let text: string
    try {
      text = await $.fs.read(`${rt.tasksDir}/${f.name}`)
    } catch {
      continue
    }
    const t = parseTaskFile(text, f.name.slice(0, -5))
    if (!t) continue
    tasks.push(t)
    times.set(t.id, f.mtimeMs)
  }
  return tasks.length ? { tasks: sortTasks(tasks), times } : undefined
}

/** Reads the plan and the tokens spent before Kvali loaded (a reload, or Kvali added mid-session). */
async function catchUp($: Engine, config: string): Promise<void> {
  const now = await $.clock.now()
  const files = await taskFiles($)
  let todos: KvTask[] | undefined
  const candidates = [...new Set([await $.session.root().catch(() => rt.cwd), rt.cwd])].map(d => `${config}/projects/${projectSlug(d)}/${rt.sessionId}.jsonl`)
  for (const file of candidates) {
    try {
      const st = await $.fs.stat(file)
      if (st.size > MAX_TRANSCRIPT) break
      const scan = scanTranscript(await $.fs.read(file))
      todos = scan.todos
      await update($, usage, () => scan.usage)
      break
    } catch {
      // not this one
    }
  }
  if (files) await update($, plan, p => advance(p, files.tasks, now, files.times))
  else if (todos?.length) await update($, plan, p => (p.tasks.length ? p : advance(p, todos!, now)))
}


/** Re-reads the phone setup at most once a minute: it may be turned on or off while the session runs. */
async function loadPhone($: Engine, now: number, force = false): Promise<void> {
  if (!rt.phoneFile || (!force && now - rt.phoneCheckedAt < 60_000)) return
  rt.phoneCheckedAt = now
  let text: string | undefined
  try {
    text = await $.fs.read(rt.phoneFile)
  } catch {
    text = undefined
  }
  rt.phone = text ? parsePhoneConfig(text) : undefined
  rt.autoPlan = autoPlanEnabled(text)
}

const PUSH_EVENT: Record<PushKind, 'needs-you' | 'done' | 'error' | 'stuck' | 'steps'> = {
  'needs-you': 'needs-you',
  finished: 'done',
  paused: 'done',
  error: 'error',
  stalled: 'stuck',
  loop: 'stuck',
  step: 'steps',
}

/** Sends one push to the phone; a failure only costs that push. */
async function push(
  $: Engine,
  kind: PushKind,
  extra: {
    label?: string
    workedMs?: number
    quietMs?: number
    sequence?: string
    doing?: string
    etaMs?: number
    loop?: { what: string; count: number; sameError: boolean; forMs: number; tokens?: number }
  } = {},
): Promise<void> {
  const cfg = rt.phone
  if (!cfg) return
  const wanted = kind === 'step' ? cfg.events.includes('steps') || cfg.events.includes('actions') : cfg.events.includes(PUSH_EVENT[kind])
  if (!wanted) return
  if (kind === 'step' && cfg.topic && !(await quietAllowed($, cfg))) return
  const p = await read($, plan)
  const u = await read($, usage)
  const { sequence, ...info } = extra
  const message: PhonePush = { ...phonePush(kind, { project: rt.project, plan: p, tokens: totalTokens(u) || undefined, ...info }, cfg.details), sequence }
  // Every channel set up; a failure costs that channel's push only.
  if (cfg.topic) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
    try {
      const res = await $.http.fetch(cfg.server, { method: 'POST', headers, body: ntfyBody(cfg, message) })
      if (res.ok && rt.budgetLeft !== undefined) rt.budgetLeft -= 1
    } catch {
      // offline or refused by policy: the pane still shows it
    }
  }
  if (cfg.telegram) await toTelegram($, cfg.telegram, message).catch(() => undefined)
  if (cfg.discord) await toDiscord($, cfg.discord.webhook, message, PUSH_COLOR[kind]).catch(() => undefined)
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/**
 * A turn's notification on Telegram: a silent progress update edits the message, an alert (the
 * turn's end) replaces it with a new one, which notifies.
 */
async function toTelegram($: Engine, t: { token: string; chatId: string }, push: PhonePush): Promise<void> {
  const api = (method: string) => `https://api.telegram.org/bot${t.token}/${method}`
  const text = telegramText(push)
  const prev = push.sequence ? rt.telegramIds.get(push.sequence) : undefined
  if (prev !== undefined && push.priority <= 2) {
    const res = await $.http.fetch(api('editMessageText'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: t.chatId, message_id: prev, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    })
    if (res.ok || /not modified/i.test(res.text)) return
  } else if (prev !== undefined) {
    await $.http.fetch(api('deleteMessage'), { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: t.chatId, message_id: prev }) }).catch(() => undefined)
  }
  const res = await $.http.fetch(api('sendMessage'), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: t.chatId, text, parse_mode: 'HTML', disable_notification: push.priority <= 2, link_preview_options: { is_disabled: true } }),
  })
  const id = res.ok ? (JSON.parse(res.text) as { result?: { message_id?: unknown } }).result?.message_id : undefined
  if (push.sequence && typeof id === 'number') remember(rt.telegramIds, push.sequence, id)
}

/** The same on Discord, through the channel's webhook. */
async function toDiscord($: Engine, webhook: string, push: PhonePush, color: number): Promise<void> {
  const body = discordBody(push, color)
  const prev = push.sequence ? rt.discordIds.get(push.sequence) : undefined
  if (prev !== undefined && push.priority <= 2) {
    const { flags: _silent, ...edit } = body
    const res = await $.http.fetch(`${webhook}/messages/${prev}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(edit) })
    if (res.ok) return
  } else if (prev !== undefined) {
    await $.http.fetch(`${webhook}/messages/${prev}`, { method: 'DELETE' }).catch(() => undefined)
  }
  const res = await $.http.fetch(`${webhook}?wait=true`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) })
  const id = res.ok ? (JSON.parse(res.text) as { id?: unknown }).id : undefined
  if (push.sequence && typeof id === 'string') remember(rt.discordIds, push.sequence, id)
}

function remember<V>(m: Map<string, V>, key: string, value: V): void {
  m.set(key, value)
  while (m.size > 20) m.delete(m.keys().next().value!)
}

/**
 * A task's end on the phone and in Claude Code. A task the phone followed always gets its end,
 * other tasks only when they were long; a stop in the middle of the plan asks the person
 * something, so it waits like a question.
 */
async function finish($: Engine, phase: KvPhase, workedMs: number, sequence: string | undefined, followed: boolean, now: number): Promise<void> {
  if (phase === 'error') quiet(push($, 'error', { label: rt.ended?.label, sequence }))
  if (phase === 'done' && (workedMs >= (rt.phone?.doneAfterSec ?? 120) * 1000 || followed)) {
    const pr = progress((await read($, plan)).tasks)
    if (pr.total > 0 && pr.done < pr.total) rt.pendingPause = { at: now, workedMs, sequence }
    else quiet(push($, 'finished', { workedMs, sequence }))
  }
  if (workedMs >= LONG_TURN_MS && phase !== 'interrupted') {
    const p = progress((await read($, plan)).tasks)
    const text = phase === 'done' ? `Done in ${fmtDuration(workedMs)}${p.total ? ` · ${p.done}/${p.total} tasks` : ''}` : `Stopped: ${rt.ended?.label}`
    $.ui.toast(text)
    quiet($.ui.notify(text, { title: 'Claude Code' }))
  }
}

/**
 * Checks the background agents against the engine's own list, which knows one that ended unheard.
 * After an answer, an agent of the main loop still at work is a background one (Kvali may have
 * loaded after it started).
 */
async function countBackground($: Engine, afterAnswer: boolean): Promise<void> {
  let agents: Awaited<ReturnType<Engine['agent']['list']>>
  try {
    agents = await $.agent.list()
  } catch {
    return
  }
  const now = await $.clock.now()
  for (const a of agents) {
    if (a.parentId || a.teammateId) continue
    const atWork = a.status === 'running' || a.status === 'pending' || a.status === 'waiting'
    if (!atWork) rt.background.delete(a.id)
    else if (afterAnswer && !rt.background.has(a.id) && !rt.finished.has(a.id)) rt.background.set(a.id, { label: a.description, startedAt: now })
  }
}

/** Forgets the calls of a finished loop: the main loop's, or a subagent's when `agent` is given. */
function dropCalls(agent?: string): void {
  for (const [id, r] of rt.running) {
    if (agent !== undefined ? r.agent === agent : !r.agent || !rt.background.has(r.agent)) rt.running.delete(id)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    rt = fresh()
    rt.cwd = e.cwd
    rt.sessionId = await $.session.id()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const config = ((await $.env.get('CLAUDE_CONFIG_DIR'))?.split(',')[0]?.trim() || (home ? `${home}/.claude` : '')).replace(/\\/g, '/')
    rt.tasksDir = config && rt.sessionId ? `${config}/tasks/${rt.sessionId}` : undefined
    rt.pulseFile = home && rt.sessionId ? `${home.replace(/\\/g, '/')}/.kvali/live/claude-code/${rt.sessionId}.mod.json` : undefined
    rt.phoneFile = home ? `${home.replace(/\\/g, '/')}/.kvali/config.json` : undefined
    rt.project = baseName(await $.session.root().catch(() => e.cwd)) || baseName(e.cwd)
    await loadPhone($, await $.clock.now(), true)
    await $.command.register({ name: 'kvali', description: 'Show live progress: plan, current step, what the agent is doing, tokens' })
    if (config && rt.sessionId) await catchUp($, config).catch(() => undefined)
    // A pane opens by itself only where it docks beside the chat.
    if (e.surface === 'desktop' || e.surface === 'vscode') quiet($.ui.open({ id: PANE, title: 'Kvali' }))
    $.clock.every(TICK_MS, () => quiet(refresh($)))
    await refresh($, true)
    return result
  })

  on('command.run', { command: 'kvali' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Kvali' })
    const p = progress((await read($, plan)).tasks)
    const where = opened.isPlaced ? 'Kvali pane opened.' : 'Kvali:'
    const what = p.total ? `${p.done}/${p.total} tasks done (${p.percent}%)${p.current ? `, now: ${p.current.title}` : ''}.` : 'no plan in this session yet.'
    return { text: `${where} ${what}` }
  })

  // Automatic planning: while the session has no unfinished plan, a prompt asks Claude to keep one.
  // The words are fixed and never contain anything from the prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    rt.loops.clear() // the person spoke: whatever the agent was stuck on is theirs to judge
    await loadPhone($, await $.clock.now())
    if (!rt.autoPlan || !wantsPlanContext(await read($, plan))) return next(e)
    rt.planAsked = true // a prompt queued into a running turn asks that turn
    rt.promptAsked = true
    return next({ ...e, context: [...(e.context ?? []), PLAN_CONTEXT] })
  }).catch(($, e, next) => next(e))

  // Claude Code keeps its task tools behind ToolSearch, where a model asked for a plan often
  // does not find them ("I have no TaskCreate"), and the progress bar stays empty. While
  // automatic planning is on they stay in the tool list. Answered once, when a session first
  // shows its tools, so it never changes under a running thread.
  on('tool.describe', { tool: ['TaskCreate', 'TaskUpdate', 'TodoWrite'] }, async ($, e, next) => {
    const described = await next(e)
    return rt.autoPlan ? { ...described, isDeferred: false } : described
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      rt.turnActive = true
      rt.turnStartedAt = now
      rt.betweenSince = now
      rt.ended = undefined
      rt.stream = undefined
      dropCalls()
      // A turn that background agents' reports set going (or a prompt meanwhile) is part of their task.
      rt.turnSeq = rt.held?.sequence ?? turnSequence(rt.sessionId, now)
      if (rt.held) rt.held.idleSince = undefined
      rt.progressSent = false
      rt.turnCalls = 0
      rt.planAsked = rt.promptAsked
      rt.promptAsked = false
      rt.pendingPause = undefined // the person answered
      rt.progressSentDone = progress((await read($, plan)).tasks).done
      quiet(refresh($))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      // A subagent's request: it shows the session is alive, the main line says what runs.
      for await (const c of next(e)) {
        rt.streamSeq += 1
        yield c
      }
      return
    }
    const now = await $.clock.now()
    rt.turnActive = true
    if (!rt.turnStartedAt) rt.turnStartedAt = now
    rt.stream = { phase: 'requesting', since: now }
    rt.pendingPhase = undefined
    rt.lastDataAt = now
    let stepUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string } | undefined
    quiet(refresh($))
    try {
      for await (const c of next(e)) {
        rt.streamSeq += 1
        if (c.kind === 'thinking') rt.pendingPhase = { phase: 'thinking' }
        else if (c.kind === 'text') rt.pendingPhase = { phase: 'writing' }
        else if (c.kind === 'tool') rt.pendingPhase = { phase: 'tool-input', label: c.name }
        else if (c.kind === 'stop' && c.usage) stepUsage = c.usage
        yield c
      }
    } finally {
      rt.stream = undefined
      rt.pendingPhase = undefined
      rt.betweenSince = await $.clock.now()
      if (stepUsage) {
        const su = stepUsage
        await update($, usage, u => ({
          ...u,
          input: u.input + su.input_tokens,
          output: u.output + su.output_tokens,
          cacheRead: u.cacheRead + su.cache_read_input_tokens,
          cacheWrite: u.cacheWrite + su.cache_creation_input_tokens,
          context: su.input_tokens + su.cache_read_input_tokens + su.cache_creation_input_tokens,
          model: su.model || u.model,
        }))
      }
      quiet(refresh($))
    }
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    const input = e as unknown as Record<string, unknown>
    const isPlan = PLAN_TOOLS.has(e.tool)
    const id = e.tool_use_id
    if (!e.agentId) rt.turnActive = true
    if (!isPlan) {
      const d = describeTool(e.tool, input, rt.cwd)
      rt.running.set(id, { ...d, startedAt: now, agent: e.agentId, asks: ASKS_PERSON[e.tool], askedAt: ASKS_PERSON[e.tool] ? now : undefined })
      await update($, recent, list => pushAction(list, { id, label: d.label, detail: d.detail, startedAt: now }))
      await update($, plan, p => (p.step ? { ...p, step: { ...p.step, actions: p.step.actions + 1 } } : p))
      quiet(refresh($))
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      rt.running.delete(id)
      rt.betweenSince = await $.clock.now()
    }
    const end = await $.clock.now()
    if (!isPlan && !e.agentId && ran.deny === undefined) {
      noteCall(rt.loops, loopKey(e.tool, describeTool(e.tool, input, rt.cwd)), describeTool(e.tool, input, rt.cwd), ran.isError === true ? resultText(ran.result) : undefined, end, totalTokens(await read($, usage)))
    }
    if (!isPlan) await update($, recent, list => endAction(list, id, end, ran.deny !== undefined || ran.isError === true))
    else if (ran.deny === undefined && !ran.isError && e.tool !== 'TaskList' && e.tool !== 'TaskGet') {
      const files = e.tool === 'TodoWrite' ? undefined : await taskFiles($)
      const current = await read($, plan)
      const tasks = files?.tasks ?? applyPlanTool(current.tasks, e.tool, input, ran.result)
      await update($, plan, p => advance(p, tasks, end, files?.times))
    }
    await refresh($)
    // A long turn that began without a plan (a resumed session, a prompt the model planned
    // nothing for) is asked once, beside a tool's result, which the model reads and the person
    // does not see.
    if (!e.agentId && !isPlan && ran.deny === undefined && rt.autoPlan) {
      rt.turnCalls += 1
      if (rt.turnCalls >= PLAN_ASK_AFTER && !rt.planAsked && wantsPlanContext(await read($, plan))) {
        rt.planAsked = true
        return { ...ran, context: [...(ran.context ?? []), PLAN_REMINDER] }
      }
    }
    return ran
  }).catch(($, e, next) => next(e)) // an observer: if it fails, the call goes on as if it were not here

  // A permission prompt: the engine asks the person before the tool runs. Where someone else
  // answers (auto mode's classifier, a host) the call is only under review: a prompt may follow.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const r = verdict.decision === 'ask' && e.tool_use_id ? rt.running.get(e.tool_use_id) : undefined
    if (r && e.approver === 'person' && asksPerson(verdict, rt.mode)) {
      markAsk(r, await $.clock.now())
      quiet(refresh($))
    } else if (r) r.review = true
    return verdict
  }).catch(($, e, next) => next(e))

  // The session's permission mode rides on the classic events: each prompt, each finished tool.
  on('classic.UserPromptSubmit', ($, e, next) => {
    if (e.permission_mode) rt.mode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUse', ($, e, next) => {
    if (e.permission_mode) rt.mode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine shows a permission prompt: a call under review was put to the person after all
  // (auto mode's classifier blocked three in a row, say), so it waits for them now.
  on('classic.Notification', async ($, e, next) => {
    if (e.permission_mode) rt.mode = e.permission_mode
    const calls = [...rt.running.values()]
    const r = e.notification_type === 'permission_prompt' && !calls.some(x => x.asks) ? calls.filter(x => x.review).pop() : undefined
    if (r) {
      markAsk(r, await $.clock.now())
      quiet(refresh($))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    rt.running.set('kvali:compact', { label: 'Compacting the conversation', startedAt: await $.clock.now() })
    quiet(refresh($))
    try {
      return await next(e)
    } finally {
      rt.running.delete('kvali:compact')
      quiet(refresh($))
    }
   }).catch(($, e, next) => next(e))

  // The subscription's usage windows, as each API response reports them: the pane shows them and
  // the editor, reading the heartbeat, warns before one runs out.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    try {
      const windows = (e.rateLimits ?? []).map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
      if (windows.length) {
        const now = await $.clock.now()
        rt.limits = { at: now, windows }
        rt.limitSamples = addLimitSamples(rt.limitSamples, windows, now)
        quiet(refresh($, true))
      }
    } catch {
      // an observer: the measurement stands
    }
    return r
  })

  // An agent the model started in the background: the turn may end while it works on.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.background && !e.parentAgentId && !e.isTeammate && !e.workflow && r.agentId) {
        rt.background.set(r.agentId, { label: e.description, startedAt: await $.clock.now() })
        quiet(refresh($))
      }
    } catch {
      // an observer: the spawn stands
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    if (e.agentId) {
      // A background agent's run ended: the task it was part of may be over.
      rt.finished.add(e.agentId)
      if (rt.background.delete(e.agentId)) {
        dropCalls(e.agentId)
        if (rt.background.size === 0 && rt.held && !rt.turnActive) rt.held.idleSince = now
        quiet(refresh($, true))
      }
      return result
    }
    rt.turnActive = false
    rt.stream = undefined
    await countBackground($, e.reason === 'answer')
    dropCalls()
    const phase: KvPhase = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'interrupted' : 'error'
    // A task that background agents carried on is timed from its first turn.
    const held = rt.held
    const workedMs = held ? now - held.startedAt : e.durationMs
    const sequence = held?.sequence ?? rt.turnSeq
    const followed = rt.progressSent || held?.followed === true
    rt.ended = {
      phase,
      since: now,
      lastTurnMs: workedMs,
      label: e.reason === 'refusal' ? 'the model declined' : e.reason === 'error' ? 'an API error ended the turn' : undefined,
    }
    rt.turnSeq = undefined
    rt.progressSent = false
    if (phase === 'done' && rt.background.size > 0) {
      // The answer handed work to agents in the background: the task ends when they are done.
      rt.held = { startedAt: held?.startedAt ?? now - e.durationMs, sequence, followed }
      await refresh($, true)
      return result
    }
    rt.held = undefined
    await refresh($, true)
    await finish($, phase, workedMs, sequence, followed, now)
    return result
  })

  on('session.end', async ($, e, next) => {
    rt.turnActive = false
    rt.stream = undefined
    rt.running.clear()
    rt.background.clear() // they end with the session
    rt.held = undefined
    rt.ended = { phase: 'ended', since: await $.clock.now() }
    rt.pendingPause = undefined
    await refresh($, true).catch(() => undefined)
    $.ui.status(undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, plan)
    const l = await read($, live)
    const acts = await read($, recent)
    const u = await read($, usage)
    const isOpen = await read($, showTasks)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns ?? 40)
    const pr = progress(p.tasks)
    const cells = barCells(pr.done, pr.inProgress, pr.total, Math.min(28, cols - 12))
    const typical = typicalMs(p)
    const line = liveLine(l, now)
    const toneColor = { ok: 'success', busy: 'suggestion', warn: 'warning', error: 'error', muted: 'inactive' }[line.tone]
    const onStep = p.step ? now - p.step.startedAt : 0
    const slow = typical !== undefined && onStep > typical * 1.5
    const tokens = totalTokens(u)
    const ctx = contextPercent(u)
    const showRecent = isActivePhase(l.phase) || (l.phase === 'done' && now - l.since < 10 * 60_000)
    const eta = isActivePhase(l.phase) ? planEtaMs(p, now) : undefined
    const loop = isActivePhase(l.phase) ? currentLoop(rt.loops, now) : undefined
    const limits = (rt.limits?.windows ?? []).map(w => {
      const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN
      return { label: limitLabel(w.kind), pct: w.percentUsed, reset: Number.isFinite(reset) ? reset : undefined, out: limitRunsOut(rt.limitSamples[w.kind]?.points ?? [], w, now) }
    })

    return (
      <Box flexDirection="column">
        {pr.total > 0 ? (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text mono color="success">{cells.done}</Text>
              <Text mono color="suggestion">{cells.active}</Text>
              <Text mono dimColor>{cells.rest}</Text>
              <Text bold>{` ${pr.done}/${pr.total}`}</Text>
              <Text dimColor>{` · ${pr.percent}%${eta !== undefined ? ` · ${fmtEta(eta)}` : ''}`}</Text>
            </Box>
            {pr.current ? <Text bold wrap="wrap">{pr.current.active ?? pr.current.title}</Text> : null}
            {pr.current && p.step ? (
              <Text color={slow ? 'warning' : 'inactive'}>
                {typical !== undefined
                  ? `${fmtDuration(onStep)} on this step · usually ~${fmtDuration(typical)}${slow ? ' · slower than usual' : ''}`
                  : `${fmtDuration(onStep)} on this step${p.step.actions ? ` · ${p.step.actions} action${p.step.actions === 1 ? '' : 's'}` : ''}`}
              </Text>
            ) : null}
          </Box>
        ) : (
          <Text dimColor wrap="wrap">No plan yet. For multi-step work Claude keeps a task list, and its progress shows here.</Text>
        )}
        {loop ? (
          <Box marginTop={1}>
            <Text color="warning" wrap="wrap">
              {`⟳ Going in circles: “${loop.detail ?? loop.label}” failed ${loop.count}× in a row${loop.sameError ? ' with the same error' : ''} · ${fmtDuration(now - loop.since)}`}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={toneColor} wrap="wrap">{`${line.icon} ${line.text}`}</Text>
        </Box>
        {l.phase === 'running' && l.detail ? <Text mono dimColor wrap="truncate-end">{l.detail}</Text> : null}
        {showRecent && acts.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {acts.slice(0, 4).map(a => (
              <Box key={`a-${a.id}`} flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end" {...(a.isError ? { color: 'error' } : { dimColor: !!a.endedAt })}>
                  {`${a.endedAt ? (a.isError ? '✕' : '✓') : '›'} ${a.label}${a.detail ? ` · ${a.detail}` : ''}`}
                </Text>
                <Text dimColor>{` ${fmtDuration((a.endedAt ?? now) - a.startedAt)}`}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {tokens > 0 ? (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {`${fmtTokens(tokens)} tokens${u.isWholeSession ? '' : ' since Kvali started'}${ctx !== undefined ? ` · context ${ctx}%` : ''}`}
            </Text>
          </Box>
        ) : null}
        {limits.length ? (
          <Text color={limits.some(x => x.out !== undefined) ? 'warning' : 'inactive'} wrap="wrap">
            {`Limits: ${limits.map(x => `${x.label} ${Math.round(x.pct)}%${x.out !== undefined ? (x.out <= now ? ' used up' : ` · runs out in ${fmtAbout(x.out - now)}`) : x.reset !== undefined && x.reset > now ? ` · resets in ${fmtMinutes(x.reset - now)}` : ''}`).join(' · ')}`}
          </Text>
        ) : null}
        {pr.total > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Button key="tasks" plain label={isOpen ? 'Hide tasks' : `Show all ${pr.total} tasks`} onPress={() => update($, showTasks, v => !v)} />
            {isOpen
              ? p.tasks.map(t => (
                  <Text wrap="wrap" bold={t.status === 'in_progress'} dimColor={t.status === 'completed'}>
                    {`${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${t.title}`}
                  </Text>
                ))
              : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
