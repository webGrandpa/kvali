import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentSession, Snapshot, TaskItem } from '../src/model.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import {
  formatPush,
  messagesLeft,
  newTopic,
  ntfyRequest,
  phoneBar,
  PhoneNotifier,
  PushPlanner,
  readPhoneConfig,
  sendPush,
  subscribeLink,
  testPush,
  writePhoneConfig,
  type PhoneConfig,
  type PhoneEvent,
  type PhonePush,
} from '../src/phone.ts';
import { qrMatrix, qrTerminal } from '../src/qr.ts';
import { Clock, appendJsonl, engineFor, tmpHome, writeJsonl, writeText } from './helpers.ts';

const ALL: { events: PhoneEvent[]; details: boolean } = { events: ['needs-you', 'done', 'error', 'stuck', 'steps'], details: true };

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    key: 'claude-code:s1',
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    id: 's1',
    title: 'Checkout page with Stripe',
    projectPath: '/Users/dev/code/storefront',
    status: 'working',
    startedAt: 0,
    updatedAt: 0,
    tasks: [],
    sources: [],
    ...over,
  };
}

const snap = (...sessions: AgentSession[]): Snapshot => ({ generatedAt: 0, sessions, errors: [] });
const tasks = (done: number, total: number): TaskItem[] =>
  Array.from({ length: total }, (_, i) => ({ id: String(i + 1), title: `Step ${i + 1}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }) as TaskItem);

test('phone setup: an unguessable topic, saved owner-only next to other settings', async () => {
  const home = tmpHome();
  const topic = newTopic();
  assert.match(topic, /^kvali-[a-km-np-z2-9]{16}$/);
  assert.notEqual(newTopic(), topic);

  writeText(path.join(home, '.kvali', 'config.json'), JSON.stringify({ other: 1 }));
  const cfg: PhoneConfig = { server: 'https://ntfy.example.com/', topic, events: ['needs-you'], details: false, token: 'tk_secret' };
  await writePhoneConfig(home, cfg);
  const file = path.join(home, '.kvali', 'config.json');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(await readPhoneConfig(home), { ...cfg, server: 'https://ntfy.example.com', doneAfterSec: 120 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).other, 1, 'other settings are kept');

  await writePhoneConfig(home, undefined);
  assert.equal(await readPhoneConfig(home), undefined);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { other: 1 });

  writeText(file, JSON.stringify({ phone: { topic: 'bad topic/../x' } }));
  assert.equal(await readPhoneConfig(home), undefined, 'an invalid topic is ignored');

  // Kvali 0.5's default (no progress) reads as today's default; a list saved since is kept as it is.
  writeText(file, JSON.stringify({ phone: { topic: 'kvali-t', events: ['needs-you', 'done', 'error', 'stuck'] } }));
  assert.deepEqual((await readPhoneConfig(home))?.events, ['needs-you', 'done', 'error', 'stuck', 'steps']);
  await writePhoneConfig(home, { server: 'https://ntfy.sh', topic: 'kvali-t', events: ['needs-you', 'done', 'error', 'stuck'], details: true });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).phone.v, 2);
  assert.deepEqual((await readPhoneConfig(home))?.events, ['needs-you', 'done', 'error', 'stuck'], 'progress turned off stays off');

  // The person's choices: live actions, and every finished task whatever its length.
  await writePhoneConfig(home, { server: 'https://ntfy.sh', topic: 'kvali-t', events: ['done', 'steps', 'actions'], details: true, doneAfterSec: 0 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).phone.doneAfter, 0);
  assert.deepEqual(await readPhoneConfig(home), { server: 'https://ntfy.sh', topic: 'kvali-t', token: undefined, events: ['done', 'steps', 'actions'], details: true, doneAfterSec: 0 });
});

test('phone links and requests', () => {
  assert.equal(subscribeLink({ server: 'https://ntfy.sh', topic: 'kvali-abc' }), 'ntfy://ntfy.sh/kvali-abc?display=Kvali');
  assert.equal(subscribeLink({ server: 'http://box.lan:8080/ntfy', topic: 't' }), 'ntfy://box.lan:8080/ntfy/t?display=Kvali&secure=false');
  const req = ntfyRequest({ server: 'https://ntfy.sh', topic: 'kvali-abc', events: [], details: true, token: 'tk_1' }, testPush());
  assert.equal(req.url, 'https://ntfy.sh');
  assert.equal(req.headers.Authorization, 'Bearer tk_1');
  assert.deepEqual(JSON.parse(req.body), { topic: 'kvali-abc', title: 'Kvali is connected', message: testPush().message, priority: 3, tags: ['white_check_mark'] });
  const update = ntfyRequest({ server: 'https://ntfy.sh', topic: 'kvali-abc', events: [], details: true }, { ...testPush(), sequence: 'kvali-1a2b-3c' });
  assert.equal(JSON.parse(update.body).sequence_id, 'kvali-1a2b-3c', 'an update names the notification it replaces');
});

test('sendPush publishes JSON to the server and reports failures in words', async () => {
  const got: { url?: string; body?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, body, auth: req.headers.authorization });
      if (JSON.parse(body).topic === 'forbidden') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end('{"error":"forbidden"}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"id":"x"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await sendPush({ server: base, topic: 'kvali-t', events: [], details: true }, { ...testPush(), title: 'Claude Code ✓ ქართული' });
    assert.deepEqual(ok, { ok: true });
    assert.equal(got[0]!.url, '/');
    assert.equal(JSON.parse(got[0]!.body!).title, 'Claude Code ✓ ქართული', 'non-ASCII titles arrive intact');
    const denied = await sendPush({ server: base, topic: 'forbidden', events: [], details: true, token: 'tk' }, testPush());
    assert.equal(denied.ok, false);
    assert.match((denied as { error: string }).error, /answered 403/);
    assert.equal(got[1]!.auth, 'Bearer tk');
  } finally {
    server.close();
  }
  const down = await sendPush({ server: 'http://127.0.0.1:9', topic: 't', events: [], details: true }, testPush());
  assert.match((down as { error: string }).error, /could not reach 127\.0\.0\.1:9/);
});

test('messagesLeft reads the day\'s allowance from the ntfy server', async () => {
  const cfg: PhoneConfig = { server: 'https://ntfy.example.com', topic: 't', events: [], details: true, token: 'tk_1' };
  const asked: { url: string; auth?: string }[] = [];
  const fake = (body: unknown, status = 200) =>
    (async (url: string, init?: RequestInit) => {
      asked.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  assert.equal(await messagesLeft(cfg, fake({ limits: { messages: 250 }, stats: { messages_remaining: 37 } })), 37);
  assert.deepEqual(asked[0], { url: 'https://ntfy.example.com/v1/account', auth: 'Bearer tk_1' });
  assert.equal(await messagesLeft(cfg, fake({ limits: { messages: 0 }, stats: { messages_remaining: 0 } })), undefined, 'no daily limit');
  assert.equal(await messagesLeft(cfg, fake({}, 500)), undefined);
});

test('push planner: a question left a minute, a long task finished, an error; nothing for short or interrupted work', () => {
  let now = 1_000_000;
  const planner = new PushPlanner({ now: () => now });
  const kinds = (s: AgentSession) => planner.observe(snap(s), ALL).map((p) => p.title);

  assert.deepEqual(kinds(session({ status: 'waiting', updatedAt: now - 60_000 })), [], 'a wait older than Kvali is not news');
  now += 1_000;
  assert.deepEqual(kinds(session({ status: 'working', updatedAt: now })), []);
  now += 1_000;
  const question = session({ status: 'waiting', statusDetail: 'Needs approval: Bash', updatedAt: now });
  assert.deepEqual(kinds(question), [], 'the person may be at the computer');
  now += 8_000;
  assert.deepEqual(kinds(session({ status: 'working', updatedAt: now })), [], 'answered within seconds: no push');
  now += 1_000;
  assert.deepEqual(kinds({ ...question, updatedAt: now }), []);
  now += 59_000;
  assert.deepEqual(kinds({ ...question, updatedAt: now - 59_000 }), []);
  now += 1_000;
  const ask = planner.observe(snap({ ...question, updatedAt: now - 60_000 }), ALL);
  assert.equal(ask[0]!.title, 'Claude Code needs you · storefront');
  assert.match(ask[0]!.message, /^Needs approval: Bash\nCheckout page with Stripe$/);
  assert.equal(ask[0]!.priority, 4);

  now += 1_000;
  kinds(session({ status: 'working', updatedAt: now, tasks: tasks(1, 3) }));
  now += 3 * 60_000;
  assert.deepEqual(kinds(session({ status: 'done', updatedAt: now, tasks: tasks(3, 3) })), [], 'waits a moment: a queued prompt may follow');
  now += 3_000;
  const done = planner.observe(snap(session({ status: 'done', updatedAt: now - 3_000, tasks: tasks(3, 3), tokens: { input: 1, output: 2, cacheRead: 3_000_000, cacheWrite: 0 } })), ALL);
  assert.equal(done[0]!.title, 'Claude Code finished · storefront');
  assert.equal(done[0]!.message, 'Checkout page with Stripe\nDone in 5m 12s · 3/3 tasks · 3.00M tokens');

  // Short work: no push. Interrupted: no push.
  now += 1_000;
  kinds(session({ status: 'working', updatedAt: now }));
  now += 30_000;
  kinds(session({ status: 'idle', updatedAt: now }));
  now += 5_000;
  assert.deepEqual(kinds(session({ status: 'idle', updatedAt: now })), []);
  kinds(session({ status: 'working', updatedAt: now }));
  now += 5 * 60_000;
  kinds(session({ status: 'idle', statusDetail: 'Interrupted', updatedAt: now }));
  now += 5_000;
  assert.deepEqual(kinds(session({ status: 'idle', statusDetail: 'Interrupted', updatedAt: now })), []);

  // An error is always worth a push; so is a stop in the middle of a plan.
  kinds(session({ status: 'working', updatedAt: now, tasks: tasks(1, 4) }));
  now += 1_000;
  assert.deepEqual(kinds(session({ status: 'error', statusDetail: 'API Error: 529 overloaded', updatedAt: now })), ['Claude Code stopped with an error · storefront']);
  kinds(session({ status: 'working', updatedAt: now, tasks: tasks(1, 4) }));
  now += 4 * 60_000;
  kinds(session({ status: 'idle', updatedAt: now, tasks: tasks(2, 4) }));
  now += 4_000;
  assert.deepEqual(kinds(session({ status: 'idle', updatedAt: now, tasks: tasks(2, 4) })), [], 'a stop mid-plan waits like a question');
  now += 60_000;
  const paused = planner.observe(snap(session({ status: 'idle', updatedAt: now, tasks: tasks(2, 4) })), ALL);
  assert.equal(paused[0]!.title, 'Claude Code stopped and is waiting for you · storefront');
  assert.equal(paused[0]!.message, 'Checkout page with Stripe\nStopped at 2/4 tasks · Step 3');
});

test('push planner: quiet, API trouble and a vanished agent, once each; plugin sessions are left to the plugin', () => {
  let now = 5_000_000;
  const planner = new PushPlanner({ now: () => now });
  const titles = (...ss: AgentSession[]) => planner.observe(snap(...ss), ALL).map((p) => p.title);

  titles(session({ status: 'working', updatedAt: now }));
  now += 11 * 60_000;
  const running = { kind: 'command' as const, label: 'pnpm build', startedAt: now - 11 * 60_000 };
  assert.deepEqual(titles(session({ status: 'working', updatedAt: now - 11 * 60_000, activity: running })), [], 'a long command is not silence');
  assert.deepEqual(titles(session({ status: 'working', updatedAt: now - 11 * 60_000 })), ['Claude Code has been quiet · storefront']);
  now += 60_000;
  assert.deepEqual(titles(session({ status: 'stale', updatedAt: now - 12 * 60_000 })), [], 'once per quiet spell');

  now += 1_000;
  const trouble = { message: 'Connection error', at: now, attempt: 3, maxAttempts: 10 };
  titles(session({ status: 'working', updatedAt: now, trouble }));
  now += 60_000;
  assert.deepEqual(titles(session({ status: 'working', updatedAt: now, trouble: { ...trouble, at: now } })), [], 'a short retry is not news');
  now += 61_000;
  const t = planner.observe(snap(session({ status: 'working', updatedAt: now, trouble: { ...trouble, at: now, attempt: 7 } })), ALL);
  assert.equal(t[0]!.title, 'Claude Code: connection or API problem · storefront');
  assert.match(t[0]!.message, /^Connection error · retry 7\/10/);
  now += 30_000;
  assert.deepEqual(titles(session({ status: 'working', updatedAt: now, trouble: { ...trouble, at: now } })), []);

  // The plugin reports its own session; Kvali still tells when it stops responding.
  const plugin = session({ key: 'claude-code:p', pushedByPlugin: true, status: 'working', updatedAt: now });
  titles(plugin);
  now += 1_000;
  assert.deepEqual(titles({ ...plugin, status: 'waiting', updatedAt: now }), []);
  now += 1_000;
  const gone = { ...plugin, status: 'stale' as const, updatedAt: now - 40_000, pulse: { phase: 'gone' as const, since: now - 40_000, at: now - 40_000 } };
  assert.deepEqual(titles(gone), ['Claude Code stopped responding · storefront']);
  assert.deepEqual(titles(gone), []);
});

test('push planner: progress is one notification per task, updated at most once a minute, replaced by its end', () => {
  let now = 9_000_000;
  const planner = new PushPlanner({ now: () => now });
  const quiet = { events: ['needs-you', 'done'] as PhoneEvent[], details: false };
  planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 4) })), ALL);
  now += 1_000;
  const marked = session({ status: 'working', updatedAt: now, tasks: tasks(1, 4).map((t) => (t.id === '2' ? { ...t, status: 'pending' as const } : t)) });
  assert.deepEqual(planner.observe(snap(marked), ALL), [], 'a new count waits a moment: the next task is marked in progress right after');
  now += 2_000;
  const step = planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(1, 4) })), ALL);
  assert.deepEqual(
    step.map((p) => [p.title, p.message, p.priority]),
    [['Claude Code · storefront · 1/4', `${phoneBar(1, 4)} 25%\nNow: Step 2`, 2]],
  );
  const seq = step[0]!.sequence!;
  assert.match(seq, /^kvali-[a-z0-9]+-[a-z0-9]+$/, 'a valid ntfy sequence ID');
  assert.equal(phoneBar(1, 4), '███░░░░░░░');

  now += 10_000;
  const between = tasks(2, 4).map((t) => (t.id === '3' ? { ...t, status: 'pending' as const } : t));
  assert.deepEqual(planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: between })), ALL), [], 'at most one a minute');
  now += 60_000;
  const later = planner.observe(snap(session({ status: 'working', updatedAt: now - 60_000, tasks: between })), ALL);
  assert.deepEqual(
    later.map((p) => [p.title, p.message, p.sequence]),
    [['Claude Code · storefront · 2/4', `${phoneBar(2, 4)} 50%\nNext: Step 3`, seq]],
    'the step finished in between goes out once the minute is over, with nothing new from the agent',
  );

  // The task's end replaces its progress notification, even though it took under two minutes.
  now += 5_000;
  planner.observe(snap(session({ status: 'done', updatedAt: now, tasks: tasks(4, 4) })), ALL);
  now += 3_000;
  const end = planner.observe(snap(session({ status: 'done', updatedAt: now - 3_000, tasks: tasks(4, 4) })), ALL);
  assert.deepEqual(
    end.map((p) => [p.title, p.sequence]),
    [['Claude Code finished · storefront', seq]],
  );

  // The next task gets a notification of its own.
  now += 60_000;
  planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 2) })), ALL);
  now += 1_000;
  planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(1, 2) })), ALL);
  now += 60_000;
  const next = planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(1, 2) })), ALL);
  assert.equal(next[0]!.title, 'Claude Code · storefront · 1/2', 'a new plan starts counting again');
  assert.notEqual(next[0]!.sequence, seq);

  assert.deepEqual(planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(1, 2) })), quiet), []);
  now += 1_000;
  const waiting = session({ status: 'waiting', statusDetail: 'Needs approval: rm -rf secrets/', updatedAt: now, tasks: tasks(1, 2) });
  assert.deepEqual(planner.observe(snap(waiting), quiet), []);
  now += 60_000;
  const ask = planner.observe(snap(waiting), quiet);
  assert.equal(ask[0]!.title, 'Claude Code needs you');
  assert.equal(ask[0]!.message, 'Waiting for your answer\n1/2 tasks');
  assert.equal(ask[0]!.sequence, undefined, 'a question is a notification of its own');
  assert.doesNotMatch(JSON.stringify(ask), /storefront|Stripe|secrets|Step/);
});

test('push planner: the person chooses the events, live actions included, and how long a task must be', () => {
  let now = 20_000_000;
  const planner = new PushPlanner({ now: () => now });
  const cfg = { events: ['done', 'steps', 'actions'] as PhoneEvent[], details: true, doneAfterSec: 0 };
  const running = (label: string, at: number) => ({ kind: 'command' as const, label, startedAt: at });
  planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 3) })), cfg);
  now += 1_000;
  const first = planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 3), activity: running('Run the tests', now) })), cfg);
  assert.deepEqual(
    first.map((p) => [p.title, p.message, p.priority]),
    [['Claude Code · storefront · 0/3', `${phoneBar(0, 3)} 0%\nNow: Step 1\nDoing: Run the tests`, 2]],
  );
  const seq = first[0]!.sequence;
  now += 10_000;
  assert.deepEqual(planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 3), activity: running('Build', now) })), cfg), [], 'at most twice a minute');
  now += 25_000;
  const next = planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 3), activity: running('Build', now - 25_000) })), cfg);
  assert.deepEqual(next.map((p) => [p.message.split('\n').at(-1), p.sequence]), [['Doing: Build', seq]], 'the latest action, in the same notification');
  now += 40_000;
  assert.deepEqual(planner.observe(snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 3), activity: running('Build', now - 65_000) })), cfg), [], 'nothing new');

  // Every task, however short, once the person asked for that.
  now += 1_000;
  planner.observe(snap(session({ key: 'claude-code:q', status: 'working', updatedAt: now })), cfg);
  now += 9_000;
  planner.observe(snap(session({ key: 'claude-code:q', status: 'done', updatedAt: now })), cfg);
  now += 3_000;
  const quick = planner.observe(snap(session({ key: 'claude-code:q', status: 'done', updatedAt: now - 3_000 })), cfg);
  assert.deepEqual(quick.map((p) => p.title), ['Claude Code finished · storefront']);
  assert.match(quick[0]!.message, /Done in 9s/);

  // Without a plan the live notification still says what runs; without details it names nothing.
  const bare = formatPush('step', session({ activity: running('pnpm build', now) }), false, { action: true });
  assert.deepEqual([bare.title, bare.message], ['Claude Code · working', 'Working']);
});

test('PhoneNotifier: progress updates pause when the day\'s ntfy allowance runs low, alerts still go', async () => {
  const sent: string[] = [];
  const lines: string[] = [];
  let left = 120;
  let now = 30_000_000;
  const planner = new PushPlanner({ now: () => now });
  let snapshot = snap(session({ status: 'working', updatedAt: now, tasks: tasks(0, 4) }));
  const home = tmpHome();
  writeText(path.join(home, '.kvali', 'config.json'), JSON.stringify({ phone: { v: 2, topic: 'kvali-t', events: ['steps', 'error'] } }));
  const notifier = new PhoneNotifier({
    home,
    snapshot: () => snapshot,
    canSend: () => true,
    planner,
    budget: async () => left,
    send: async (_cfg, p) => {
      sent.push(p.title);
      return { ok: true };
    },
    report: (line) => lines.push(line),
  });
  await notifier.tick();
  now += 3_000;
  snapshot = snap(session({ status: 'working', updatedAt: now, tasks: tasks(1, 4) }));
  await notifier.tick();
  now += 3_000;
  await notifier.tick();
  assert.deepEqual(sent, ['Claude Code · storefront · 1/4']);

  left = 40; // another sender used the day up; the next check sees it
  (notifier as unknown as { leftAt: number }).leftAt = -Infinity;
  now += 61_000;
  snapshot = snap(session({ status: 'working', updatedAt: now, tasks: tasks(2, 4) }));
  await notifier.tick();
  now += 3_000;
  await notifier.tick();
  assert.equal(sent.length, 1, 'the update waits');
  assert.match(lines.at(-1)!, /paused: 40 notifications left today on ntfy\.sh/);
  now += 1_000;
  snapshot = snap(session({ status: 'error', statusDetail: 'API Error', updatedAt: now, tasks: tasks(2, 4) }));
  await notifier.tick();
  assert.deepEqual(sent.at(-1), 'Claude Code stopped with an error · storefront', 'an alert still goes');
  notifier.dispose();
});

test('PhoneNotifier: a finished turn reaches the phone though nothing changes after it', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const SID = '7d1e2f3a-2222-4b5c-8d9e-0f1a2b3c4d5e';
  const at = (ms: number) => ({ sessionId: SID, cwd: '/work/shop', version: '2.1.316', timestamp: clock.iso(ms) });
  const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000 };
  const reply = (ms: number, id: string, block: unknown, stop: string) => ({
    ...at(ms),
    type: 'assistant',
    requestId: `req_${id}`,
    uuid: id,
    message: { id: `msg_${id}`, model: 'claude-opus-5-5', role: 'assistant', type: 'message', content: [block], stop_reason: stop, usage },
  });
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...at(0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Refactor the checkout page' } },
    reply(1_000, 'a', { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pnpm test', description: 'Run the tests' } }, 'tool_use'),
    { ...at(145_000), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
  ]);
  // Set up by Kvali 0.5: the old default list, which now includes progress.
  writeText(path.join(home, '.kvali', 'config.json'), JSON.stringify({ phone: { server: 'https://ntfy.example.com', topic: 'kvali-t', events: ['needs-you', 'done', 'error', 'stuck'], details: true } }));
  clock.advance(150_000);

  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  const sent: PhonePush[] = [];
  const notifier = new PhoneNotifier({
    home,
    snapshot: () => engine.snapshot,
    canSend: () => true,
    planner: new PushPlanner({ now: clock.now }),
    send: async (_cfg, p) => {
      sent.push(p);
      return { ok: true };
    },
  });
  let published = 0;
  engine.onSnapshot(() => {
    published += 1;
    void notifier.tick();
  });

  await engine.tick();
  await notifier.tick();
  assert.equal(engine.snapshot.sessions[0]!.status, 'working');
  assert.deepEqual(notifier.config?.events, ['needs-you', 'done', 'error', 'stuck', 'steps']);

  appendJsonl(file, [reply(150_000, 'b', { type: 'text', text: 'Done: the checkout page is refactored.' }, 'end_turn')]);
  clock.advance(1_000);
  await engine.tick();
  await notifier.tick();
  assert.equal(published, 2);
  assert.equal(sent.length, 0, 'waits a moment: a queued prompt may follow');

  clock.advance(5_000);
  await engine.tick();
  assert.equal(published, 2, 'nothing changed, so the engine publishes nothing');
  await notifier.tick(); // what its clock does every few seconds
  assert.deepEqual(sent.map((p) => p.title), ['Claude Code finished · shop']);
  assert.match(sent[0]!.message, /\nDone in 2m 31s · /);
  notifier.dispose();
});

test('QR codes: a matrix for the panel and half blocks for a terminal', () => {
  const m = qrMatrix('ntfy://ntfy.sh/kvali-abcdefghijkmnpqr?display=Kvali');
  assert.ok(m.length >= 25 && m.length % 4 === 1, 'a valid QR size');
  assert.ok(m[0]![0] && m[0]![6] && !m[0]![7], 'finder pattern in the corner');
  const text = qrTerminal('hello', false);
  assert.equal(text.split('\n').length, Math.ceil((qrMatrix('hello').length + 4) / 2));
  assert.match(qrTerminal('hello'), /^\x1b\[38;5;16;48;5;231m/);
});
