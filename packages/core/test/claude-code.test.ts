import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { progressOf } from '../src/model.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl, writeText } from './helpers.ts';

const SID = '0b7c4f9e-1111-4a2b-9c3d-5e6f7a8b9c0d';
const CWD = '/work/shop';

function base(clock: Clock, offset: number) {
  return { sessionId: SID, cwd: CWD, version: '2.1.316', gitBranch: 'main', timestamp: clock.iso(offset) };
}

/** One API response split into one line per content block, each repeating the usage (as Claude Code does). */
function assistant(clock: Clock, offset: number, id: string, blocks: unknown[], stop: string, usage = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 } }) {
  return blocks.map((b, i) => ({
    ...base(clock, offset + i),
    type: 'assistant',
    requestId: `req_${id}`,
    uuid: `${id}-${i}`,
    message: { id: `msg_${id}`, model: 'claude-opus-5-5', role: 'assistant', type: 'message', content: [b], stop_reason: stop, usage },
  }));
}

function toolResult(clock: Clock, offset: number, toolUseId: string, text: string, toolUseResult?: unknown) {
  return {
    ...base(clock, offset),
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    toolUseResult,
  };
}

test('Claude Code: tasks, activity, de-duplicated tokens, cost and status transitions', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);

  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Add a checkout page with tests' } },
    { type: 'ai-title', sessionId: SID, aiTitle: 'Checkout page' },
    ...assistant(clock, 1_000, 'a', [
      { type: 'thinking', thinking: '…' },
      { type: 'tool_use', id: 'tu_1', name: 'TaskCreate', input: { subject: 'Build checkout form', activeForm: 'Building checkout form' } },
      { type: 'tool_use', id: 'tu_2', name: 'TaskCreate', input: { subject: 'Write tests', activeForm: 'Writing tests' } },
    ], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'Task #1 created successfully', { task: { id: '1', subject: 'Build checkout form' } }),
    toolResult(clock, 2_001, 'tu_2', 'Task #2 created successfully: Write tests'),
    ...assistant(clock, 3_000, 'b', [{ type: 'tool_use', id: 'tu_3', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }], 'tool_use'),
    toolResult(clock, 3_500, 'tu_3', 'ok'),
    ...assistant(clock, 4_000, 'c', [
      { type: 'tool_use', id: 'tu_4', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
      { type: 'tool_use', id: 'tu_5', name: 'Bash', input: { command: 'pnpm vitest run', description: 'Run the test suite' } },
    ], 'tool_use'),
    toolResult(clock, 4_500, 'tu_4', 'ok'),
  ]);
  clock.advance(10_000);

  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.title, 'Checkout page');
  assert.equal(s.titleFromPrompt, undefined, "Claude's own title");
  assert.equal(s.status, 'working');
  assert.equal(s.projectPath, CWD);
  assert.equal(s.activity?.label, 'Run the test suite');
  assert.equal(s.activity?.detail, 'pnpm vitest run');
  assert.deepEqual(
    s.tasks.map((t) => [t.id, t.status]),
    [
      ['1', 'completed'],
      ['2', 'in_progress'],
    ],
  );
  assert.equal(progressOf(s.tasks).percent, 50);
  assert.equal(s.turn?.steps, 5, 'five tool calls since the prompt');
  assert.equal(s.current?.taskId, '2', 'the in-progress task is timed');
  assert.equal(s.current?.steps, 1, 'one action (the test run) since task 2 started');
  assert.equal(s.recent?.[0].label, 'Run the test suite');
  assert.equal(s.recent?.[0].endedAt, undefined, 'still running');
  // 3 API responses, each written as several lines: usage must be counted once per response.
  assert.deepEqual(s.tokens, { input: 30, output: 600, cacheRead: 15_000, cacheWrite: 3_000, reasoning: 0 });
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $8 1h cache write (per MTok).
  const expected = (30 * 4 + 600 * 20 + 15_000 * 0.2 + 3_000 * 8) / 1e6;
  assert.ok(Math.abs((s.costUsd ?? 0) - expected) < 1e-9);
  assert.deepEqual(s.context, { used: 6_010, window: 200_000 });

  // A permission prompt reported by the hooks wins over the transcript.
  writeText(
    path.join(home, '.kvali', 'live', 'claude-code', `${SID}.json`),
    JSON.stringify({ sessionId: SID, event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: clock.t }),
  );
  s = await only(engine);
  assert.equal(s.status, 'waiting');
  assert.match(s.statusDetail ?? '', /permission/);

  // The tool finishes and the turn ends: newer transcript lines clear the prompt.
  clock.advance(5_000);
  appendJsonl(file, [
    toolResult(clock, 0, 'tu_5', 'All tests passed'),
    ...assistant(clock, 100, 'd', [{ type: 'tool_use', id: 'tu_6', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }], 'tool_use'),
    toolResult(clock, 200, 'tu_6', 'ok'),
    ...assistant(clock, 300, 'e', [{ type: 'text', text: 'Done. Checkout page and tests are in place.' }], 'end_turn'),
  ]);
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.status, 'done');
  assert.equal(progressOf(s.tasks).percent, 100);
  assert.equal(s.activity, undefined);
});

test('Claude Code: the tasks directory is authoritative and TodoWrite is a fallback', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: 'Refactor the API client' } },
    ...assistant(clock, 1_000, 'a', [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Map endpoints', status: 'completed', activeForm: 'Mapping endpoints' },
            { content: 'Extract fetch wrapper', status: 'in_progress', activeForm: 'Extracting fetch wrapper' },
            { content: 'Update callers', status: 'pending', activeForm: 'Updating callers' },
          ],
        },
      },
    ], 'tool_use'),
  ]);
  clock.advance(2_000);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.title, 'Refactor the API client');
  assert.equal(s.titleFromPrompt, true, 'the first prompt, kept off the phone');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.equal(s.tasks[1].activeTitle, 'Extracting fetch wrapper');

  const taskDir = path.join(home, '.claude', 'tasks', SID);
  writeText(path.join(taskDir, '1.json'), JSON.stringify({ id: '1', subject: 'Plan', status: 'completed', blocks: [], blockedBy: [] }));
  writeText(path.join(taskDir, '2.json'), JSON.stringify({ id: '2', subject: 'Ship', status: 'completed', blocks: [], blockedBy: [] }));
  appendJsonl(file, [...assistant(clock, 0, 'b', [{ type: 'text', text: 'Finished.' }], 'end_turn')]);
  clock.advance(1_000);
  s = await only(engine);
  assert.deepEqual(s.tasks.map((t) => t.title), ['Plan', 'Ship']);
  assert.equal(s.status, 'done');
});

test('Claude Code: after compaction the current step is timed from the task files', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const t0 = clock.t;
  // The plan was made before the conversation was compacted, so the transcript has no Task tools.
  const taskDir = path.join(home, '.claude', 'tasks', SID);
  const task = (id: string, status: string, atMin: number) => {
    const f = path.join(taskDir, `${id}.json`);
    writeText(f, JSON.stringify({ id, subject: `Step ${id}`, status, blocks: [], blockedBy: [] }));
    utimesSync(f, new Date(t0 + atMin * 60_000), new Date(t0 + atMin * 60_000));
  };
  task('1', 'completed', 0);
  task('2', 'completed', 6);
  task('3', 'completed', 10);
  task('4', 'completed', 10.05); // batch-completed with 3: not a duration
  task('5', 'in_progress', 10.1);
  task('6', 'pending', 0);
  clock.advance(15 * 60_000);
  writeJsonl(path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`), [
    { ...base(clock, -60_000), type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation.' } },
    ...assistant(clock, -30_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pnpm build', description: 'Build' } }], 'tool_use'),
  ]);
  const s = await only(engineFor(new ClaudeCodeAdapter(), home, clock));
  assert.equal(s.status, 'working');
  assert.equal(s.current?.taskId, '5');
  assert.equal(s.current?.startedAt, t0 + 10.1 * 60_000, 'the step started when its file changed');
  assert.equal(s.current?.typicalMs, 5 * 60_000, 'median of 6m and 4m; the batch completion is skipped');
});

test('Claude Code: interrupts, staleness and injected text are handled', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: '<system-reminder>internal</system-reminder>' } },
    { ...base(clock, 1), type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the flaky login test' }] } },
    ...assistant(clock, 1_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: `${CWD}/src/login.test.ts` } }], 'tool_use'),
  ]);
  clock.advance(2_000);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock, { staleAfterMs: 60_000 });
  let s = await only(engine);
  assert.equal(s.title, 'Fix the flaky login test');
  assert.equal(s.activity?.detail, 'src/login.test.ts');

  clock.advance(5 * 60_000);
  s = await only(engine);
  assert.equal(s.status, 'stale');

  appendJsonl(file, [{ ...base(clock, 0), type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }]);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Interrupted');
});

test('Claude Code: subagent transcripts add tokens to the parent session', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.claude', 'projects', '-work-shop');
  writeJsonl(path.join(dir, `${SID}.jsonl`), [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: 'Audit the repo' } },
    ...assistant(clock, 1_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Task', input: { description: 'Scan dependencies', subagent_type: 'Explore' } }], 'tool_use', {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as any),
  ]);
  writeJsonl(path.join(dir, SID, 'subagents', 'agent-a1b2c3.jsonl'), [
    ...assistant(clock, 2_000, 'sub1', [{ type: 'text', text: 'scanning' }], 'end_turn', {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    } as any),
  ]);
  clock.advance(3_000);
  const s = await only(engineFor(new ClaudeCodeAdapter(), home, clock));
  assert.equal(s.tokens?.input, 101);
  assert.equal(s.tokens?.output, 51);
  assert.equal(s.activity?.kind, 'subagent');
  assert.equal(s.activeSubagents, 1);
});

test('Claude Code: the Kvali plugin heartbeat gives exact liveness, and its silence means the agent is gone', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: 'Refactor the checkout' } },
    ...assistant(clock, 1_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/work/shop/a.ts' } }], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'ok'),
  ]);
  const beat = path.join(home, '.kvali', 'live', 'claude-code', `${SID}.mod.json`);
  const write = (body: Record<string, unknown>) => writeText(beat, JSON.stringify({ v: 1, agent: 'claude-code', sessionId: SID, ...body }));

  // Six silent minutes would look stuck; the heartbeat says the model is thinking.
  clock.advance(6 * 60_000);
  write({ at: clock.t - 2_000, phase: 'thinking', since: clock.t - 6 * 60_000, push: true });
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.pushedByPlugin, true, 'the plugin sends this session\'s phone notifications');
  assert.deepEqual([s.pulse?.phase, s.pulse?.since], ['thinking', clock.t - 6 * 60_000]);

  // A question for the person, reported by the plugin without any hooks.
  write({ at: clock.t, phase: 'needs-you', since: clock.t, label: 'allow Bash (rm -rf dist)?' });
  s = await only(engine);
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Needs you: allow Bash (rm -rf dist)?');

  // Working, then neither the heartbeat nor the transcript changes: closed or frozen.
  write({ at: clock.t, phase: 'running', since: clock.t, label: 'Run the tests' });
  s = await only(engine);
  assert.equal(s.pulse?.phase, 'running');
  clock.advance(45_000);
  s = await only(engine);
  assert.equal(s.status, 'stale');
  assert.equal(s.pulse?.phase, 'gone');

  // A finished turn is the transcript's to report: a terminal phase adds nothing.
  write({ at: clock.t, phase: 'done', since: clock.t });
  appendJsonl(file, [...assistant(clock, 0, 'b', [{ type: 'text', text: 'Done.' }], 'end_turn')]);
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.pulse, undefined);
  assert.notEqual(s.status, 'stale');
});

test('Claude Code: where the plugin runs, the hooks kept beside it are not heard; without it they are', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: 'Refactor the checkout' } },
    ...assistant(clock, 1_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/work/shop/a.ts' } }], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'ok'),
  ]);
  clock.advance(10_000);
  // A hook's idle notification says the session waits for the person.
  const hookFile = path.join(home, '.kvali', 'live', 'claude-code', `${SID}.json`);
  writeText(hookFile, JSON.stringify({ event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash', at: clock.t }));
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'waiting', 'without the plugin the hooks are what Kvali hears');

  // The plugin runs in the session and says the model is thinking: the hook's event is not heard.
  writeText(path.join(home, '.kvali', 'live', 'claude-code', `${SID}.mod.json`), JSON.stringify({ v: 1, agent: 'claude-code', sessionId: SID, at: clock.t, phase: 'thinking', since: clock.t - 5_000 }));
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.pulse?.phase, 'thinking');
});

test('Claude Code: a session woken after its turn ended starts a new turn, timed from what woke it', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Open a PR for the checkout page' } },
    ...assistant(clock, 1_000, 'a', [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'gh pr create', description: 'Open the PR' } }], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'https://github.com/acme/shop/pull/1'),
    ...assistant(clock, 3_000, 'b', [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'PR opened.' }], 'end_turn'),
  ]);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.turn?.steps, 1);
  const promptAt = s.turn!.startedAt;

  // Two days later the PR's checks wake the session: no prompt from the person.
  clock.advance(2 * 86_400_000);
  const wokeAt = clock.t;
  appendJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'The PR checks finished.' } },
    ...assistant(clock, 1_000, 'c', [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'gh pr checks 1', description: "Look at the PR's checks" } }], 'tool_use'),
    toolResult(clock, 2_000, 'tu_2', 'all green'),
    // A notification that arrives while the model works belongs to the same turn.
    { ...base(clock, 2_500), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'Another check finished.' } },
    ...assistant(clock, 3_000, 'd', [{ type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: '/work/shop/notes.md', content: 'ok' } }], 'tool_use'),
  ]);
  clock.advance(10_000);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.turn?.startedAt, wokeAt, 'timed from the wake-up, not from the prompt two days before');
  assert.notEqual(s.turn?.startedAt, promptAt);
  assert.equal(s.turn?.steps, 2);

  // A response with nothing before it after the turn ended (a continuation): timed from the response.
  appendJsonl(file, [toolResult(clock, 0, 'tu_3', 'ok'), ...assistant(clock, 500, 'e', [{ type: 'text', text: 'All green.' }], 'end_turn')]);
  clock.advance(3_600_000);
  const resumedAt = clock.t;
  appendJsonl(file, assistant(clock, 0, 'f', [{ type: 'tool_use', id: 'tu_4', name: 'Bash', input: { command: 'gh pr merge 1', description: 'Merge the PR' } }], 'tool_use'));
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.turn?.startedAt, resumedAt);
  assert.equal(s.turn?.steps, 1);
});

test('Claude Code: agents started in the background keep the session working until they report back', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.claude', 'projects', '-work-shop');
  const file = path.join(dir, `${SID}.jsonl`);
  // What the Agent tool answers for run_in_background, and what Claude Code sends when one ends.
  const launched = (agentId: string, description: string) => ({ isAsync: true, status: 'async_launched', agentId, description, prompt: '…', outputFile: `/tmp/${agentId}.output` });
  const notice = (id: string, status: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>tu_${id}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "${id}" ${status}</summary>\n<result>…</result>\n</task-notification>`;
  /** A subagent's transcript, last written at the clock's current time. */
  const subagentWrites = (id: string) => {
    const f = path.join(dir, SID, 'subagents', `agent-${id}.jsonl`);
    writeJsonl(f, assistant(clock, 0, `sub_${id}`, [{ type: 'tool_use', id: `tu_s_${id}`, name: 'Read', input: { file_path: '/work/shop/auth.ts' } }], 'tool_use'));
    utimesSync(f, clock.t / 1000, clock.t / 1000);
  };

  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Review the auth module and write the missing tests' } },
    ...assistant(clock, 1_000, 'a', [
      { type: 'tool_use', id: 'tu_1', name: 'Agent', input: { description: 'Review auth', prompt: '…', subagent_type: 'general-purpose', run_in_background: true } },
      { type: 'tool_use', id: 'tu_2', name: 'Agent', input: { description: 'Write tests', prompt: '…', subagent_type: 'general-purpose', run_in_background: true } },
    ], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'Async agent launched successfully.', launched('a1', 'Review auth')),
    toolResult(clock, 2_001, 'tu_2', 'Async agent launched successfully.', launched('a2', 'Write tests')),
    ...assistant(clock, 3_000, 'b', [{ type: 'text', text: 'Two agents are on it.' }], 'end_turn'),
  ]);
  const handedOffAt = clock.t + 3_000;
  clock.advance(5_000);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working', 'the answer ended the turn, the agents work on');
  assert.deepEqual([s.activity?.kind, s.activity?.label, s.activity?.detail, s.activity?.startedAt], ['subagent', '2 background agents', 'Review auth, Write tests', handedOffAt]);

  // Their transcripts keep it alive past the time a silent session would count as stuck.
  clock.advance(25 * 60_000);
  subagentWrites('a1');
  clock.advance(20 * 60_000);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.activeSubagents, undefined, 'none wrote in the last minute');
  // Nothing written anywhere for half an hour: they ended unseen (Claude Code closed, say).
  clock.advance(11 * 60_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, undefined);
  // Still at it after all.
  subagentWrites('a2');
  clock.advance(5_000);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.activeSubagents, 1);

  // One reports back: Claude Code wakes the session with it, the answer leaves one at work.
  appendJsonl(file, [{ ...base(clock, 0), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: notice('a1', 'completed') } }]);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.kind, 'thinking');
  appendJsonl(file, assistant(clock, 2_000, 'c', [{ type: 'text', text: 'The review is in; tests are still being written.' }], 'end_turn'));
  clock.advance(5_000);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.deepEqual([s.activity?.label, s.activity?.detail], ['1 background agent', 'Write tests']);
  assert.equal(s.turns, 1, 'a notification is not a prompt from the person');

  // The last one reports back while the person's next turn runs: when that turn ends, all is done.
  appendJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Also bump the version' } },
    ...assistant(clock, 1_000, 'd', [{ type: 'tool_use', id: 'tu_3', name: 'Edit', input: { file_path: '/work/shop/package.json' } }], 'tool_use'),
    { ...base(clock, 1_500), type: 'attachment', attachment: { type: 'queued_command', prompt: notice('a2', 'failed'), origin: { kind: 'task-notification' } } },
    toolResult(clock, 2_000, 'tu_3', 'ok'),
    ...assistant(clock, 3_000, 'e', [{ type: 'text', text: 'Bumped. The test writer failed; want me to retry?' }], 'end_turn'),
  ]);
  clock.advance(5_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.activity, undefined);

  // Agents end with their session.
  appendJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Retry it in the background' } },
    ...assistant(clock, 1_000, 'f', [{ type: 'tool_use', id: 'tu_4', name: 'Agent', input: { description: 'Write tests', prompt: '…', run_in_background: true } }], 'tool_use'),
    toolResult(clock, 2_000, 'tu_4', 'Async agent launched successfully.', launched('a3', 'Write tests')),
    ...assistant(clock, 3_000, 'g', [{ type: 'text', text: 'Retrying.' }], 'end_turn'),
  ]);
  clock.advance(5_000);
  s = await only(engine);
  assert.equal(s.status, 'working');
  writeText(path.join(home, '.kvali', 'live', 'claude-code', `${SID}.json`), JSON.stringify({ event: 'SessionEnd', at: clock.t }));
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Session ended');
});

test('Claude Code: a workflow started in the background counts as work until it reports back', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.claude', 'projects', '-work-shop');
  const file = path.join(dir, `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Run the review workflow' } },
    ...assistant(clock, 1_000, 'a', [
      { type: 'tool_use', id: 'tu_1', name: 'Workflow', input: { script: '…' } },
      { type: 'tool_use', id: 'tu_2', name: 'Workflow', input: { script: '…' } },
    ], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'Workflow launched.', { status: 'async_launched', taskId: 'w7k2', taskType: 'local_workflow', workflowName: 'review-changes', runId: 'wf_1', summary: 'Review changed files' }),
    // A script that does not compile starts nothing.
    toolResult(clock, 2_100, 'tu_2', 'Workflow failed.', { status: 'async_launched', taskId: 'w9x9', taskType: 'local_workflow', workflowName: 'broken', error: 'compile failed' }),
    ...assistant(clock, 3_000, 'b', [{ type: 'text', text: 'The workflow is running.' }], 'end_turn'),
  ]);
  // Its agents' transcripts live under subagents/workflows/<run>/ and their tokens count.
  writeJsonl(path.join(dir, SID, 'subagents', 'workflows', 'wf_1', 'agent-b1.jsonl'), assistant(clock, 2_500, 'w1', [{ type: 'text', text: 'reviewing' }], 'end_turn', { input_tokens: 700, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any));
  clock.advance(5_000);
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working');
  assert.deepEqual([s.activity?.label, s.activity?.detail], ['1 workflow', 'review-changes']);
  assert.equal(s.tokens?.input, 10 + 10 + 700);

  appendJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>w7k2</task-id>\n<task-type>local_workflow</task-type>\n<status>completed</status>\n<summary>Workflow "review-changes" completed</summary>\n</task-notification>' } },
    ...assistant(clock, 2_000, 'c', [{ type: 'text', text: 'The review found two issues.' }], 'end_turn'),
  ]);
  clock.advance(5_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
});

test('Claude Code: the plugin counts background agents exactly, a stop from the task list too', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  const launched = (agentId: string) => ({ isAsync: true, status: 'async_launched', agentId, description: `Task ${agentId}`, prompt: '…', outputFile: '' });
  writeJsonl(file, [
    { ...base(clock, 0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Split the migration in two' } },
    ...assistant(clock, 1_000, 'a', [
      { type: 'tool_use', id: 'tu_1', name: 'Agent', input: { description: 'Task a1', prompt: '…', run_in_background: true } },
      { type: 'tool_use', id: 'tu_2', name: 'Agent', input: { description: 'Task a2', prompt: '…', run_in_background: true } },
    ], 'tool_use'),
    toolResult(clock, 2_000, 'tu_1', 'Async agent launched successfully.', launched('a1')),
    toolResult(clock, 2_001, 'tu_2', 'Async agent launched successfully.', launched('a2')),
    ...assistant(clock, 3_000, 'b', [{ type: 'text', text: 'Both halves are running.' }], 'end_turn'),
  ]);
  const beat = path.join(home, '.kvali', 'live', 'claude-code', `${SID}.mod.json`);
  const write = (body: Record<string, unknown>) => writeText(beat, JSON.stringify({ v: 1, agent: 'claude-code', sessionId: SID, ...body }));
  clock.advance(10_000);
  write({ at: clock.t, phase: 'running', since: clock.t - 7_000, label: '2 background agents', background: 2 });
  const engine = engineFor(new ClaudeCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.pulse?.label, '2 background agents');

  // Both stopped from Claude Code's task list: no notification, the plugin's count says so.
  clock.advance(60_000);
  write({ at: clock.t, phase: 'done', since: clock.t - 67_000, background: 0 });
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.activity, undefined);
});

test("Claude Code: a subagent's own plan stays out of the session's, also from the shared task list", async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-10T19:00:00.000Z');
  const dir = path.join(home, '.claude', 'projects', '-work-shop');
  const created = (offset: number, n: number, subject: string) => [
    ...assistant(clock, offset, `c${n}`, [{ type: 'tool_use', id: `tc${n}`, name: 'TaskCreate', input: { subject, description: subject } }], 'tool_use'),
    toolResult(clock, offset + 10, `tc${n}`, `Task #${n} created successfully: ${subject}`, { task: { id: String(n), subject } }),
  ];
  writeJsonl(path.join(dir, `${SID}.jsonl`), [
    { ...base(clock, 0), type: 'user', message: { role: 'user', content: 'Draw the cards' } },
    ...created(1_000, 1, 'Read the repo'),
    ...created(2_000, 2, 'Draw the cards'),
    ...assistant(clock, 3_000, 'u2', [{ type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }], 'tool_use'),
    toolResult(clock, 3_010, 'tu2', 'Updated task #1 status'),
    ...assistant(clock, 4_000, 'ag', [{ type: 'tool_use', id: 'tu_ag', name: 'Task', input: { description: 'Draw', subagent_type: 'general-purpose' } }], 'tool_use'),
  ]);
  // The subagent makes a task of its own, and the engine keeps it in the session's list.
  writeJsonl(path.join(dir, SID, 'subagents', 'agent-x1.jsonl'), [
    ...assistant(clock, 5_000, 's1', [{ type: 'tool_use', id: 'sc3', name: 'TaskCreate', input: { subject: 'Export the cover', description: 'x' } }], 'tool_use'),
    toolResult(clock, 5_010, 'sc3', 'Task #3 created successfully: Export the cover', { task: { id: '3', subject: 'Export the cover' } }),
  ]);
  const taskDir = path.join(home, '.claude', 'tasks', SID);
  writeText(path.join(taskDir, '1.json'), JSON.stringify({ id: '1', subject: 'Read the repo', status: 'completed', blocks: [], blockedBy: [] }));
  writeText(path.join(taskDir, '2.json'), JSON.stringify({ id: '2', subject: 'Draw the cards', status: 'in_progress', blocks: [], blockedBy: [] }));
  writeText(path.join(taskDir, '3.json'), JSON.stringify({ id: '3', subject: 'Export the cover', status: 'completed', blocks: [], blockedBy: [] }));
  clock.advance(6_000);
  const s = await only(engineFor(new ClaudeCodeAdapter(), home, clock));
  assert.deepEqual(s.tasks.map((t) => t.title), ['Read the repo', 'Draw the cards']);
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 2, percent: 50 });
});
