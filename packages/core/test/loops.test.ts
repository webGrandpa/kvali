import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { codexFailure } from '../src/adapters/codex.ts';
import type { AgentSession, Snapshot } from '../src/model.ts';
import { PushPlanner, type PhoneEvent } from '../src/phone.ts';
import { LoopWatch, errorSignature, loopKey } from '../src/util/loop-watch.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl } from './helpers.ts';

const MIN = 60_000;
const test_ = { kind: 'command' as const, label: 'Run the tests', detail: 'pnpm test' };

test('LoopWatch: the same error four times in a row is a loop; a new error is progress; a success or the person ends it', () => {
  const w = new LoopWatch();
  const fail = (at: number, err = 'FAIL src/cart.test.ts\nExpected 3, received 2 (took 1.2s)') => w.observe(loopKey(test_), test_, err, at, 1_000 + at);
  fail(0);
  w.observe('Edit:src/cart.ts', { label: 'Edit', detail: 'src/cart.ts' }, undefined, 1); // edits in between do not break it
  fail(2 * MIN);
  fail(4 * MIN, 'FAIL src/cart.test.ts\nExpected 3, received 2 (took 0.9s)'); // only a timing changed: the same error
  assert.equal(w.current(5 * MIN), undefined, 'three is not yet a loop');
  fail(6 * MIN);
  assert.deepEqual(w.current(7 * MIN), { label: 'Run the tests', detail: 'pnpm test', count: 4, sameError: true, since: 0, tokensAtStart: 1_000 });

  // A different error each time is progress, until there are very many.
  const p = new LoopWatch();
  for (let i = 0; i < 7; i++) p.observe(loopKey(test_), test_, `FAIL test ${'abcdefg'[i]}`, i * MIN);
  assert.equal(p.current(8 * MIN), undefined);
  p.observe(loopKey(test_), test_, 'FAIL test h', 8 * MIN);
  assert.equal(p.current(9 * MIN)?.sameError, false);
  assert.equal(p.current(9 * MIN)?.count, 8);

  // The command passing ends it, and so does the person stepping in; old failures are forgotten.
  w.observe(loopKey(test_), test_, undefined, 8 * MIN);
  assert.equal(w.current(9 * MIN), undefined);
  p.reset();
  assert.equal(p.current(9 * MIN), undefined);
  const old = new LoopWatch();
  for (let i = 0; i < 4; i++) old.observe('k', test_, 'same', i);
  assert.equal(old.current(60 * MIN), undefined);
  assert.equal(errorSignature('took 12ms at port 8080'), errorSignature('took 7ms at port 3000'));
});

test('codexFailure reads the exit code of JSON and text shell output', () => {
  assert.equal(codexFailure(JSON.stringify({ output: 'ok', metadata: { exit_code: 0, duration_seconds: 0.2 } })), undefined);
  assert.equal(codexFailure(JSON.stringify({ output: 'boom', metadata: { exit_code: 1, duration_seconds: 0.2 } })), 'boom');
  assert.match(codexFailure('Exit code: 2\nWall time: 1.1 seconds\nOutput:\nerror[E0425]')!, /E0425/);
  assert.match(codexFailure('Chunk ID: 1\nWall time: 3 seconds\nProcess exited with code 101\nOutput:\npanicked')!, /panicked/);
  assert.equal(codexFailure('Exit code: 0\nOutput:\nall good'), undefined);
  assert.equal(codexFailure('Success. Updated the following files:\nM src/a.rs'), undefined);
});

test('Claude Code: a command that keeps failing with the same error marks the session as going in circles', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const SID = '0b7c4f9e-1111-4a2b-9c3d-5e6f7a8b9c0d';
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  const base = (offset: number) => ({ sessionId: SID, cwd: '/work/shop', timestamp: clock.iso(offset) });
  const usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000 };
  const call = (offset: number, id: string, command: string) => ({
    ...base(offset),
    type: 'assistant',
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run the tests' } }], stop_reason: 'tool_use', usage },
  });
  const result = (offset: number, id: string, error?: string) => ({
    ...base(offset),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ?? 'ok', ...(error ? { is_error: true } : {}) }] },
  });
  const failure = 'Exit code 1\nFAIL src/cart.test.ts > totals\nAssertionError: expected 3 to be 2';
  const records: unknown[] = [{ ...base(0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Fix the cart totals' } }];
  for (let i = 0; i < 4; i++) records.push(call(i * 60_000 + 1_000, `tu_${i}`, 'pnpm test'), result(i * 60_000 + 30_000, `tu_${i}`, failure));
  writeJsonl(file, records);
  clock.advance(4 * MIN);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.loop?.detail, 'pnpm test');
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.sameError, true);
  assert.equal(s.loop?.since, clock.t - 4 * MIN + 30_000);
  assert.equal(s.loop?.tokens, 3 * (10 + 200 + 5_000 + 1_000), 'the three responses since the first failure');

  // The person steps in: it is theirs to judge now.
  appendJsonl(file, [{ ...base(0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'The test is wrong, change the expectation' } }]);
  s = await only(engine);
  assert.equal(s.loop, undefined);
});

test('phone: one push when an agent goes in circles', () => {
  let now = 1_000_000_000_000;
  const planner = new PushPlanner({ now: () => now });
  const cfg = { events: ['stuck'] as PhoneEvent[], details: true };
  const session = (loop?: AgentSession['loop']): AgentSession => ({
    key: 'claude-code:s1',
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    id: 's1',
    title: 'Fix the cart totals',
    projectPath: '/work/shop',
    status: 'working',
    startedAt: now - 30 * MIN,
    updatedAt: now,
    tasks: [],
    sources: [],
    loop,
  });
  const snap = (s: AgentSession): Snapshot => ({ generatedAt: now, sessions: [s], errors: [] });
  planner.observe(snap(session()), cfg);
  now += MIN;
  const loop = { label: 'Run the tests', detail: 'pnpm test', count: 4, sameError: true, since: now - 12 * MIN, tokens: 180_000 };
  const pushes = planner.observe(snap(session(loop)), cfg);
  assert.deepEqual(
    pushes.map((p) => [p.title, p.message, p.priority, p.tags]),
    [['Claude Code is going in circles · shop', '“pnpm test” failed 4 times in a row with the same error · for 12m 00s · 180k tokens. It may need a hint from you.\nFix the cart totals', 4, ['repeat']]],
  );
  now += MIN;
  assert.deepEqual(planner.observe(snap(session({ ...loop, count: 5 })), cfg), [], 'once per loop');
  const quiet = planner.observe(snap(session({ ...loop, since: now })), { events: ['stuck'], details: false });
  assert.equal(quiet[0]?.message, 'The same action failed 4 times in a row with the same error · for 0s · 180k tokens. It may need a hint from you.', 'no command without details');
});
