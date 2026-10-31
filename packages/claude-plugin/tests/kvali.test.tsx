import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.UTC(2026, 9, 31, 10, 0, 0)
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'kvali',
  component: 'Pane',
  requestId: 'kvali',
  props: {
    title: 'Kvali',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type File = { text: string; mtimeMs: number }

/** Answers what the mod asks of the engine, with a small in-memory file system. */
function engine(on: On, files: Record<string, File> = {}) {
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  const missing = (path: string) => new Error(`ENOENT: ${path}`)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/w' }))
  on('command.register', () => ({ value: { command: 'kvali' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('fs.list', (_, e) => {
    const dir = `${e.path}/`
    const names = Object.keys(files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
    if (!names.length) throw missing(e.path)
    return { value: names.map(p => ({ name: p.slice(dir.length), kind: 'file' as const, size: files[p]!.text.length, mtimeMs: files[p]!.mtimeMs, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const f = files[e.path]
    if (!f) throw missing(e.path)
    return { value: f.text }
  })
  on('fs.stat', (_, e) => {
    const f = files[e.path]
    if (!f) throw missing(e.path)
    return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  const pushes: { url: string; auth?: string; body: Record<string, unknown> }[] = []
  on('http.fetch', (_, e) => {
    pushes.push({ url: e.url, auth: e.init?.headers?.Authorization, body: JSON.parse(e.init?.body ?? '{}') })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  return { writes, toasts, pushes }
}

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100, model: 'claude-opus-5-5' }

test('a plan made with the Tasks tools: progress, the step on its clock, every surface', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  engine(on)
  let nextId = 1
  on('tool.call', (_, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: String(nextId++), subject: e.subject } } } : { result: {} }))

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  for (const subject of ['Map the routes', 'Rewrite the loaders', 'Remove the old router']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(60_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Rewriting the loaders' })
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'pnpm test --run', description: 'Run the tests' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /\/3$/ }))?.text).toBe(' 1/3')
    expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toBe(' · 33%')
    expect((await ui.find({ type: 'Text', text: /^Rewriting/ }))?.text).toBe('Rewriting the loaders')
    expect((await ui.find({ type: 'Text', text: /on this step/ }))?.text).toBe('30s on this step · usually ~1m 00s')
    expect((await ui.find({ type: 'Text', text: /Run the tests/ }))?.text).toBe('✓ Run the tests · pnpm test --run')
    await ui.press({ key: 'tasks' })
    expect((await ui.find({ type: 'Text', text: /old router/ }))?.text).toBe('○ Remove the old router')
    await ui.press({ key: 'tasks' })
    await ui.unmount()
  }
})

test('liveness comes from the stream: thinking, no data from the API, done', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const { toasts, writes } = engine(on)
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'thinking', index: 0, text: 'Let me look', ref: 1 }
    await gate
    yield { kind: 'text', index: 1, text: 'Done.', ref: 2 }
    yield { kind: 'stop', stopReason: 'end_turn', usage, ref: 3 }
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(4_000)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /Thinking/ }))?.text).toBe('● Thinking · 4s')
  await term.unmount()
  const beat = JSON.parse(writes.at(-1)!.text)
  expect(writes.at(-1)!.path).toBe('/home/u/.kvali/live/claude-code/s1.mod.json')
  expect(beat).toMatchObject({ v: 1, sessionId: 's1', phase: 'thinking' })

  await clock.advance(95_000)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Text', text: /No data from the API/ }))?.text).toMatch(/^⚠ No data from the API for 1m 3\ds\./)
  await desk.unmount()

  release()
  while (!(await it.next()).done) {
    // drain
  }
  await $.turn.complete({ answer: 'Done.', durationMs: 150_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const code = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await code.find({ type: 'Text', text: /Done in/ }))?.text).toBe('✓ Done in 2m 30s')
  expect((await code.find({ type: 'Text', text: /tokens/ }))?.text).toBe('1.1k tokens since Kvali started · context 1%')
  await code.unmount()
  expect(toasts).toEqual(['Done in 2m 30s'])
  expect(JSON.parse(writes.at(-1)!.text).phase).toBe('done')
})

test('a question for the person shows as "Needs you" while it waits', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  engine(on)
  let answer!: () => void
  const answered = new Promise<void>(r => {
    answer = r
  })
  on('tool.call', async () => {
    await answered
    return { result: {} }
  })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(2_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await ui.find({ type: 'Text', text: /Needs you/ }))?.text).toBe('! Needs you: Claude asked you a question')
  await ui.unmount()
  answer()
  await call
})

test('catches up from the task files and the transcript when it loads mid-session', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const task = (id: string, subject: string, status: string) => JSON.stringify({ id, subject, status, blocks: [], blockedBy: [] })
  const line = (id: string, req: string) =>
    JSON.stringify({ type: 'assistant', requestId: req, message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'x' }] } })
  const { writes } = engine(on, {
    '/home/u/.claude/tasks/s1/1.json': { text: task('1', 'Plan', 'completed'), mtimeMs: T0 - 600_000 },
    '/home/u/.claude/tasks/s1/2.json': { text: task('2', 'Build', 'completed'), mtimeMs: T0 - 300_000 },
    '/home/u/.claude/tasks/s1/3.json': { text: task('3', 'Test', 'in_progress'), mtimeMs: T0 - 120_000 },
    '/home/u/.claude/tasks/s1/4.json': { text: task('4', 'Ship', 'pending'), mtimeMs: T0 - 600_000 },
    // Claude Code repeats a response's usage on each of its blocks: counted once.
    '/home/u/.claude/projects/-w/s1.jsonl': { text: [line('m1', 'r1'), line('m1', 'r1'), line('m2', 'r2')].join('\n'), mtimeMs: T0 },
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/4$/ }))?.text).toBe(' 2/4')
  expect((await ui.find({ type: 'Text', text: /on this step/ }))?.text).toBe('2m 00s on this step · usually ~5m 00s')
  expect((await ui.find({ type: 'Text', text: /tokens/ }))?.text).toBe('2.3k tokens · context 1%')
  await ui.unmount()
  const beat = JSON.parse(writes.at(-1)!.text)
  expect(beat.step).toMatchObject({ title: 'Test', startedAt: T0 - 120_000, typicalMs: 300_000 })
})

test('phone notifications: needs you, a long turn finished, the API going quiet; one each', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const phone = { phone: { server: 'https://ntfy.example.com', topic: 'kvali-test', token: 'tk_1', events: ['needs-you', 'done', 'error', 'stuck'], details: true } }
  const { pushes, writes } = engine(on, { '/home/u/.kvali/config.json': { text: JSON.stringify(phone), mtimeMs: T0 } })
  let answer!: () => void
  const answered = new Promise<void>(r => {
    answer = r
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') await answered
    return { result: {} }
  })
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'thinking', index: 0, text: 'hm', ref: 1 }
    await gate
    yield { kind: 'stop', stopReason: 'end_turn', usage, ref: 2 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/w/shop', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(4_000)
  await clock.advance(4_000)
  answer()
  await call
  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toMatchObject({ url: 'https://ntfy.example.com', auth: 'Bearer tk_1', body: { topic: 'kvali-test', title: 'Claude Code needs you · w', priority: 4, tags: ['bell'] } })
  expect(pushes[0]!.body.message).toBe('Claude asked you a question')

  const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })[Symbol.asyncIterator]()
  await it.next()
  await clock.advance(100_000)
  await clock.advance(10_000)
  expect(pushes.map(p => p.body.title)).toEqual(['Claude Code needs you · w', 'Claude Code: no data from the API · w'])
  release()
  while (!(await it.next()).done) {
    // drain
  }
  await $.turn.complete({ answer: '', durationMs: 180_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(pushes.at(-1)!.body).toMatchObject({ title: 'Claude Code finished · w', message: 'Done in 3m 00s · 1.1k tokens', tags: ['white_check_mark'] })
  expect(pushes).toHaveLength(3)
  expect(JSON.parse(writes.at(-1)!.text).push).toBe(true)
})

test('without a phone setup nothing is sent, and the heartbeat says so', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  const { pushes, writes } = engine(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '', durationMs: 600_000, isAborted: false, turnId: 't1', reason: 'error' })
  await clock.advance(2_000)
  expect(pushes).toHaveLength(0)
  expect(JSON.parse(writes.at(-1)!.text).push).toBe(false)
})
