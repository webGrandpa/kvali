import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { KvAction, KvLive, KvPhase, KvTask } from '../types'
import {
  ASKS_PERSON,
  EMPTY_PLAN,
  EMPTY_USAGE,
  IDLE,
  PLAN_TOOLS,
  STALL_MS,
  advance,
  applyPlanTool,
  baseName,
  ntfyBody,
  parsePhoneConfig,
  phonePush,
  barCells,
  contextPercent,
  describeTool,
  endAction,
  fmtDuration,
  fmtTokens,
  isActivePhase,
  liveLine,
  parseTaskFile,
  progress,
  projectSlug,
  pushAction,
  scanTranscript,
  sortTasks,
  statusText,
  totalTokens,
  typicalMs,
  type PhoneCfg,
  type PushKind,
} from './model'

type Engine = EngineInterface

const PANE = 'kvali'
const TICK_MS = 2_000
const PULSE_EVERY_MS = 10_000
const LONG_TURN_MS = 120_000
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
  asks?: string
  /** The same question for a phone push: no command text leaves the computer. */
  askPush?: string
  askedAt?: number
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
})

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
  const l = derive(now)
  await loadPhone($, now)
  if (l.phase === 'needs-you' && rt.pushedNeedsFor !== l.since) {
    rt.pushedNeedsFor = l.since
    const asking = [...rt.running.values()].filter(r => r.asks).pop()
    quiet(push($, 'needs-you', { label: asking?.askPush ?? asking?.asks ?? l.label }))
  } else if (l.phase === 'stalled' && rt.pushedStallFor !== l.since) {
    rt.pushedStallFor = l.since
    quiet(push($, 'stalled', { quietMs: now - l.since }))
  }
  const key = [l.phase, l.since, l.label ?? '', l.detail ?? ''].join('|')
  if (key !== rt.lastLiveKey || force) {
    rt.lastLiveKey = key
    await update($, live, () => l)
  }
  if (isActivePhase(l.phase)) $.ui.invalidate('ui.render')
  const status = statusText(await read($, plan), l, now)
  if (status !== rt.lastStatus) {
    rt.lastStatus = status
    $.ui.status(status)
  }
  await pulse($, l, now, force)
}

/**
 * The bridge to Kvali's editor extension and terminal dashboard: one small file per
 * session, rewritten while a turn runs. Its age is the proof of life: a working session
 * whose file stops changing was closed or froze, which nothing else can tell.
 */
async function pulse($: Engine, l: KvLive, now: number, force: boolean): Promise<void> {
  if (!rt.pulseFile) return
  const key = [l.phase, l.since, l.label ?? ''].join('|')
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
  try {
    rt.phone = parsePhoneConfig(await $.fs.read(rt.phoneFile))
  } catch {
    rt.phone = undefined
  }
}

const PUSH_EVENT: Record<PushKind, 'needs-you' | 'done' | 'error' | 'stuck' | 'steps'> = {
  'needs-you': 'needs-you',
  finished: 'done',
  paused: 'done',
  error: 'error',
  stalled: 'stuck',
  step: 'steps',
}

/** Sends one push to the phone; a failure only costs that push. */
async function push($: Engine, kind: PushKind, extra: { label?: string; workedMs?: number; quietMs?: number } = {}): Promise<void> {
  const cfg = rt.phone
  if (!cfg || !cfg.events.includes(PUSH_EVENT[kind])) return
  const p = await read($, plan)
  const u = await read($, usage)
  const body = ntfyBody(cfg, phonePush(kind, { project: rt.project, plan: p, tokens: totalTokens(u) || undefined, ...extra }, cfg.details))
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
  try {
    await $.http.fetch(cfg.server, { method: 'POST', headers, body })
  } catch {
    // offline or refused by policy: the pane still shows it
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

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      const now = await $.clock.now()
      rt.turnActive = true
      rt.turnStartedAt = now
      rt.betweenSince = now
      rt.ended = undefined
      rt.stream = undefined
      rt.running.clear()
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
      rt.running.set(id, { ...d, startedAt: now, asks: ASKS_PERSON[e.tool], askedAt: ASKS_PERSON[e.tool] ? now : undefined })
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
    if (!isPlan) await update($, recent, list => endAction(list, id, end, ran.deny !== undefined || ran.isError === true))
    else if (ran.deny === undefined && !ran.isError && e.tool !== 'TaskList' && e.tool !== 'TaskGet') {
      const files = e.tool === 'TodoWrite' ? undefined : await taskFiles($)
      const current = await read($, plan)
      const tasks = files?.tasks ?? applyPlanTool(current.tasks, e.tool, input, ran.result)
      await update($, plan, p => advance(p, tasks, end, files?.times))
      const before = progress(current.tasks).done
      const after = progress(tasks).done
      if (after > before && after < tasks.length && end - rt.lastStepPushAt >= 60_000) {
        rt.lastStepPushAt = end
        quiet(push($, 'step'))
      }
    }
    await refresh($)
    return ran
  }).catch(($, e, next) => next(e)) // an observer: if it fails, the call goes on as if it were not here

  // A permission prompt: the engine asks the person before the tool runs.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.approver === 'person' && e.tool_use_id) {
      const r = rt.running.get(e.tool_use_id)
      if (r) {
        r.asks = `allow ${r.label}${r.detail ? ` (${r.detail})` : ''}?`
        r.askPush = `allow ${r.label}?`
        r.askedAt = await $.clock.now()
        quiet(refresh($))
      }
    }
    return verdict
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

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    const now = await $.clock.now()
    rt.turnActive = false
    rt.stream = undefined
    rt.running.clear()
    const phase: KvPhase = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'interrupted' : 'error'
    rt.ended = {
      phase,
      since: now,
      lastTurnMs: e.durationMs,
      label: e.reason === 'refusal' ? 'the model declined' : e.reason === 'error' ? 'an API error ended the turn' : undefined,
    }
    await refresh($, true)
    if (phase === 'error') quiet(push($, 'error', { label: rt.ended.label }))
    if (e.durationMs >= LONG_TURN_MS && phase === 'done') {
      const pr = progress((await read($, plan)).tasks)
      quiet(push($, pr.total > 0 && pr.done < pr.total ? 'paused' : 'finished', { workedMs: e.durationMs }))
    }
    if (e.durationMs >= LONG_TURN_MS && phase !== 'interrupted') {
      const p = progress((await read($, plan)).tasks)
      const text = phase === 'done' ? `Done in ${fmtDuration(e.durationMs)}${p.total ? ` · ${p.done}/${p.total} tasks` : ''}` : `Stopped: ${rt.ended.label}`
      $.ui.toast(text)
      quiet($.ui.notify(text, { title: 'Claude Code' }))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    rt.turnActive = false
    rt.stream = undefined
    rt.running.clear()
    rt.ended = { phase: 'ended', since: await $.clock.now() }
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

    return (
      <Box flexDirection="column">
        {pr.total > 0 ? (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text mono color="success">{cells.done}</Text>
              <Text mono color="suggestion">{cells.active}</Text>
              <Text mono dimColor>{cells.rest}</Text>
              <Text bold>{` ${pr.done}/${pr.total}`}</Text>
              <Text dimColor>{` · ${pr.percent}%`}</Text>
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
