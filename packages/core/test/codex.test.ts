import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter, codexPrompt } from '../src/adapters/codex.ts';
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

test('Codex: a session resumed days after it began is found in its first day\'s folder', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-28T08:00:00.000Z');
  const began = new Date(clock.t - 12 * 86_400_000);
  const dir = path.join(home, '.codex', 'sessions', String(began.getFullYear()), String(began.getMonth() + 1).padStart(2, '0'), String(began.getDate()).padStart(2, '0'));
  // A reverted thread's rollout: "<thread id>_<rollout id>". The thread's id is the one that resumes it.
  const ROLLOUT = '019a2b3c-4d5e-7f60-8a9b-ffffffffffff';
  const file = path.join(dir, `rollout-2026-11-16T08-00-00-${ID}_${ROLLOUT}.jsonl`);
  const line = (offset: number, type: string, payload: unknown) => ({ timestamp: clock.iso(offset), type, payload });
  writeJsonl(file, [
    { timestamp: began.toISOString(), type: 'session_meta', payload: { id: ID, timestamp: began.toISOString(), cwd: '/work/api', originator: 'codex_cli_rs', cli_version: '0.172.0' } },
    line(0, 'turn_context', { cwd: '/work/api', model: 'gpt-6.2-sol' }),
    line(1, 'event_msg', { type: 'task_started' }),
    line(2, 'event_msg', { type: 'user_message', message: 'Pick the migration up again' }),
  ]);
  clock.advance(5_000);
  const engine = engineFor(new CodexAdapter(), home, clock);
  const s = await only(engine);
  assert.equal(s.id, ID);
  assert.equal(s.status, 'working');
});

test('Codex Desktop: its guardian checks are not sessions, and a thread is titled by the person\'s message', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-28T09:00:00.000Z');
  const d = new Date(clock.t);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const line = (offset: number, type: string, payload: unknown) => ({ timestamp: clock.iso(offset), type, payload });
  const GUARDIAN = '01a220f4-d3ed-76f1-b622-2dbcb64d516f';
  // Under "approve for me", Codex Desktop asks a guardian thread about each command.
  writeJsonl(path.join(dir, `rollout-2026-11-28T09-00-00-${GUARDIAN}.jsonl`), [
    line(0, 'session_meta', { id: GUARDIAN, cwd: '/work/alltrainers', originator: 'Codex Desktop', source: { subagent: { other: 'guardian' } } }),
    line(1, 'turn_context', { cwd: '/work/alltrainers', model: 'gpt-6.2-sol' }),
    line(2, 'event_msg', { type: 'task_started' }),
    line(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Is this command safe to run? wsl.exe -d Ubuntu …' }] }),
    line(4, 'event_msg', { type: 'task_complete' }),
  ]);
  // Codex Desktop writes no user_message events.
  const file = path.join(dir, `rollout-2026-11-28T09-00-01-${ID}.jsonl`);
  writeJsonl(file, [
    line(1, 'session_meta', { id: ID, cwd: '/work/alltrainers', originator: 'Codex Desktop', source: 'vscode', cli_version: '0.190.0' }),
    line(2, 'turn_context', { cwd: '/work/alltrainers', model: 'gpt-6.2-sol' }),
    line(3, 'event_msg', { type: 'task_started' }),
    line(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/alltrainers\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>' }] }),
    line(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work/alltrainers</cwd>\n  <shell>powershell</shell>\n</environment_context>' }] }),
    line(4, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write the staging mail tests\nand run them' }] }),
    line(5, 'event_msg', { type: 'item_completed', item: { type: 'reasoning' } }),
    line(6, 'token_usage_record', { input_tokens: 1_000 }),
    line(7, 'response_item', { type: 'custom_tool_call', name: 'shell_command', call_id: 'c1', input: 'Get-Content infra/docker/staging_cli.py | Select-Object -Skip 148 -First 106' }),
  ]);
  clock.advance(10_000);
  const s = await only(engineFor(new CodexAdapter(), home, clock));
  assert.equal(s.id, ID);
  assert.equal(s.title, 'Write the staging mail tests');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.host, 'app', 'Codex Desktop is an app: Kvali cannot take you into it');
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Shell');
  assert.equal(s.activity?.detail, 'Get-Content infra/docker/staging_cli.py | Select-Object -Skip 148 -First 106');
});

test('Codex Desktop: different commands failing in a row are not a loop, the same one failing is', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-28T09:00:00.000Z');
  const d = new Date(clock.t);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const file = path.join(dir, `rollout-2026-11-28T09-00-00-${ID}.jsonl`);
  const line = (offset: number, type: string, payload: unknown) => ({ timestamp: clock.iso(offset), type, payload });
  const fail = 'Exit code: 1\nWall time: 0.4 seconds\nOutput:\nThe term is not recognized as a name of a cmdlet';
  // Two long scripts that begin alike, and others: all different, all failing.
  const script = (n: number) => `function Update-MailFile($path, [scriptblock]$transform) { $absolute = Join-Path (Get-Location) $path; <# step ${n} #> }`;
  const records: unknown[] = [
    line(0, 'session_meta', { id: ID, cwd: '/work/alltrainers', originator: 'Codex Desktop', source: 'vscode' }),
    line(1, 'event_msg', { type: 'task_started' }),
    line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the mail tests' }] }),
  ];
  for (let i = 0; i < 6; i += 1) {
    records.push(line(10 + i * 2, 'response_item', { type: 'custom_tool_call', name: 'shell_command', call_id: `d${i}`, input: script(i) }));
    records.push(line(11 + i * 2, 'response_item', { type: 'custom_tool_call_output', call_id: `d${i}`, output: fail }));
  }
  writeJsonl(file, records);
  clock.advance(60_000);
  const engine = engineFor(new CodexAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.loop, undefined);

  const again: unknown[] = [];
  for (let i = 0; i < 4; i += 1) {
    again.push(line(70 + i * 2, 'response_item', { type: 'custom_tool_call', name: 'shell_command', call_id: `e${i}`, input: 'npm.cmd exec -- prettier --check src/lib/auth/auth-links.ts' }));
    again.push(line(71 + i * 2, 'response_item', { type: 'custom_tool_call_output', call_id: `e${i}`, output: fail }));
  }
  appendJsonl(file, again);
  clock.advance(60_000);
  s = await only(engine);
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.detail, 'npm.cmd exec -- prettier --check src/lib/auth/auth-links.ts');

  // A new message from the person: what it was stuck on is theirs to judge now.
  appendJsonl(file, [line(200, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use pnpm instead' }] })]);
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.loop, undefined);
  assert.equal(s.title, 'Fix the mail tests');
});

test('codexPrompt: the person\'s words, not the context Codex or the editor put around them', () => {
  assert.equal(codexPrompt('Add rate limiting'), 'Add rate limiting');
  assert.equal(codexPrompt('<environment_context>\n<cwd>/w</cwd>\n</environment_context>'), undefined);
  assert.equal(codexPrompt('<user_instructions>Be brief</user_instructions>'), undefined);
  assert.equal(codexPrompt('# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>x</INSTRUCTIONS>'), undefined);
  assert.equal(codexPrompt('# Context from my IDE setup:\n\n## Active file: src/a.ts\n\n## My request for Codex:\nFix the login redirect\n'), 'Fix the login redirect');
  assert.equal(codexPrompt('# Context from my IDE setup:\n\n## Open tabs:\n- a.ts'), undefined);
  assert.equal(codexPrompt('   '), undefined);
});
