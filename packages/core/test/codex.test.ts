import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { progressOf } from '../src/model.ts';
import { Pricing } from '../src/pricing.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl } from './helpers.ts';

const ID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';

test('Codex: plan, tokens, rate limits and turn status from a rollout file', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const d = new Date(clock.t);
  const dir = path.join(
    home,
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  const file = path.join(dir, `rollout-2026-10-30T10-00-00-${ID}.jsonl`);
  const line = (offset: number, type: string, payload: unknown) => ({ timestamp: clock.iso(offset), type, payload });

  writeJsonl(file, [
    line(0, 'session_meta', { id: ID, session_id: ID, timestamp: clock.iso(0), cwd: '/work/api', originator: 'codex_cli_rs', cli_version: '0.98.0' }),
    line(1, 'turn_context', { cwd: '/work/api', model: 'gpt-5.5-codex', approval_policy: 'on-request' }),
    line(2, 'event_msg', { type: 'task_started' }),
    line(3, 'event_msg', { type: 'user_message', message: 'Add rate limiting to the public API' }),
    line(10, 'response_item', {
      type: 'function_call',
      name: 'update_plan',
      call_id: 'call_1',
      arguments: JSON.stringify({
        plan: [
          { step: 'Pick a limiter', status: 'completed' },
          { step: 'Add middleware', status: 'in_progress' },
          { step: 'Write tests', status: 'pending' },
          { step: 'Document headers', status: 'pending' },
        ],
      }),
    }),
    line(11, 'response_item', { type: 'function_call_output', call_id: 'call_1', output: 'Plan updated' }),
    line(20, 'response_item', { type: 'function_call', name: 'shell', call_id: 'call_2', arguments: JSON.stringify({ command: ['bash', '-lc', 'cargo test -p api'] }) }),
    line(21, 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 12_000, cached_input_tokens: 9_000, output_tokens: 800, reasoning_output_tokens: 300, total_tokens: 12_800 },
        last_token_usage: { input_tokens: 6_000, cached_input_tokens: 5_000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 6_400 },
        model_context_window: 272_000,
      },
      rate_limits: {
        primary: { used_percent: 34.5, window_minutes: 300, resets_at: Math.round(clock.t / 1000) + 3_600 },
        secondary: { used_percent: 12, window_minutes: 10_080, resets_at: Math.round(clock.t / 1000) + 86_400 },
        plan_type: 'plus',
      },
    }),
  ]);
  clock.advance(1_000);

  const engine = engineFor(new CodexAdapter(), home, clock, { pricing: new Pricing({ 'gpt-5.5*': { input: 1.25, output: 10, cacheRead: 0.125 } }) });
  let s = await only(engine);
  assert.equal(s.agent, 'codex');
  assert.equal(s.title, 'Add rate limiting to the public API');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.model, 'gpt-5.5-codex');
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Shell');
  assert.equal(s.activity?.detail, 'cargo test -p api');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 4, percent: 25 });
  assert.equal(s.turn?.steps, 2);
  assert.deepEqual(s.tokens, { input: 3_000, cacheRead: 9_000, cacheWrite: 0, output: 800, reasoning: 300 });
  assert.deepEqual(s.context, { used: 6_400, window: 272_000 });
  assert.equal(s.rateLimits?.[0].label, '5h');
  assert.equal(s.rateLimits?.[0].usedPercent, 34.5);
  assert.equal(s.rateLimits?.[1].label, 'Weekly');
  const expected = (3_000 * 1.25 + 800 * 10 + 9_000 * 0.125) / 1e6;
  assert.ok(Math.abs((s.costUsd ?? 0) - expected) < 1e-9);

  appendJsonl(file, [
    line(2_000, 'response_item', { type: 'function_call_output', call_id: 'call_2', output: 'ok' }),
    line(2_001, 'event_msg', { type: 'task_complete', last_agent_message: 'Rate limiting added.' }),
  ]);
  clock.advance(3_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.activity, undefined);
});

test('Codex: subagent threads are hidden', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const d = new Date(clock.t);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  writeJsonl(path.join(dir, `rollout-2026-10-30T10-00-00-${ID}.jsonl`), [
    { timestamp: clock.iso(0), type: 'session_meta', payload: { id: ID, cwd: '/w', parent_thread_id: 'x', agent_role: 'explorer', timestamp: clock.iso(0) } },
  ]);
  const snap = await engineFor(new CodexAdapter(), home, clock).tick();
  assert.equal(snap.sessions.length, 0);
});
