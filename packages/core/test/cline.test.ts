import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ClineAdapter, RooCodeAdapter } from '../src/adapters/cline.ts';
import { progressOf } from '../src/model.ts';
import { editorUserDataDirs } from '../src/util/editors.ts';
import { Clock, engineFor, only, tmpHome, writeText } from './helpers.ts';

const json = (v: unknown) => JSON.stringify(v);
/** `<userData>` of VS Code on this platform, inside the test's home. */
const vscodeUserData = (home: string) => editorUserDataDirs(home, {}, process.platform)[0];

test('Cline: a task in VS Code: plan, approvals, tokens and the finish', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const store = path.join(vscodeUserData(home), 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  const id = '1762423200000';
  const file = path.join(store, 'tasks', id, 'ui_messages.json');
  writeText(path.join(store, 'state', 'taskHistory.json'), json([{ id, ts: clock.t, task: 'x', tokensIn: 0, tokensOut: 0, totalCost: 0, cwdOnTaskInitialization: '/work/shop' }]));
  const model = { modelId: 'claude-sonnet-4-5', providerId: 'anthropic', mode: 'act' };
  const t0 = clock.t - 120_000;
  const messages: any[] = [
    { ts: t0, type: 'say', say: 'task', text: 'Add a dark mode toggle to the settings page\nand remember the choice' },
    { ts: t0 + 1_000, type: 'say', say: 'api_req_started', text: json({ request: '…', tokensIn: 1_200, tokensOut: 300, cacheWrites: 5_000, cacheReads: 0, cost: 0.05 }), modelInfo: model },
    { ts: t0 + 4_000, type: 'say', say: 'text', text: 'I will look at the settings page first.', modelInfo: model },
    { ts: t0 + 5_000, type: 'say', say: 'task_progress', text: '- [x] Find the settings page\n- [ ] Add the toggle\n- [ ] Persist the choice', modelInfo: model },
    { ts: t0 + 6_000, type: 'say', say: 'tool', text: json({ tool: 'readFile', path: 'src/settings.tsx', content: '/work/shop/src/settings.tsx' }), modelInfo: model },
    { ts: t0 + 7_000, type: 'say', say: 'api_req_started', text: json({ tokensIn: 900, tokensOut: 250, cacheWrites: 0, cacheReads: 5_000, cost: 0.01 }), modelInfo: model },
    { ts: clock.t - 10_000, type: 'ask', ask: 'command', text: 'pnpm test REQ_APP', modelInfo: model },
  ];
  writeText(file, json(messages));

  const engine = engineFor(new ClineAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'cline');
  assert.equal(s.agentLabel, 'Cline');
  assert.equal(s.title, 'Add a dark mode toggle to the settings page');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.projectPath, '/work/shop');
  assert.equal(s.model, 'claude-sonnet-4-5');
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Needs approval: run pnpm test');
  assert.equal(s.activity?.label, 'Shell');
  assert.deepEqual(s.tokens, { input: 2_100, output: 550, cacheRead: 5_000, cacheWrite: 5_000, reasoning: 0 });
  assert.equal(Math.round((s.costUsd ?? 0) * 100) / 100, 0.06);
  // The focus chain only checks items off: the first open one is the step in progress.
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.equal(s.tasks[1]?.status, 'in_progress');
  assert.equal(s.turn?.steps, 2);
  assert.equal(s.context?.used, 5_900);

  // A just-written ask may be auto-approved: it counts as waiting only once it stands.
  messages[messages.length - 1].ts = clock.t - 1_000;
  writeText(file, json(messages));
  s = await only(engine);
  assert.equal(s.status, 'working');

  // The command runs, the plan completes, the task ends with its result.
  clock.advance(60_000);
  messages.push(
    { ts: clock.t - 50_000, type: 'say', say: 'command_output', text: 'all 12 tests passed' },
    { ts: clock.t - 40_000, type: 'say', say: 'task_progress', text: '- [x] Find the settings page\n- [x] Add the toggle\n- [x] Persist the choice' },
    { ts: clock.t - 30_000, type: 'say', say: 'completion_result', text: 'Dark mode is in.' },
    { ts: clock.t - 30_000, type: 'ask', ask: 'completion_result', text: '' },
  );
  writeText(file, json(messages));
  s = await only(engine);
  assert.equal(s.status, 'done');
  assert.equal(s.statusDetail, 'Task completed');
  assert.deepEqual(progressOf(s.tasks), { done: 3, inProgress: 0, total: 3, percent: 100 });
  const day = Object.values(s.daily ?? {});
  assert.equal(day.reduce((n, d) => n + (d.tasksDone ?? 0), 0), 2);
  assert.ok((day[0]?.activeMs ?? 0) > 0);
});

test('Cline: errors, a stopped request, retries and repeated failures', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const file = path.join(home, '.cline', 'data', 'tasks', '1762423100000', 'ui_messages.json');
  const t0 = clock.t - 600_000;
  const base: any[] = [{ ts: t0, type: 'say', say: 'task', text: 'Fix the date parser' }];
  // The same edit failing with the same error, again and again: a loop.
  for (let i = 0; i < 4; i += 1) {
    base.push(
      { ts: t0 + 10_000 * i + 1, type: 'say', say: 'api_req_started', text: json({ tokensIn: 100, tokensOut: 50, cost: 0.001 }) },
      { ts: t0 + 10_000 * i + 2, type: 'say', say: 'tool', text: json({ tool: 'editedExistingFile', path: 'src/date.ts' }) },
      { ts: t0 + 10_000 * i + 3, type: 'say', say: 'diff_error', text: 'src/date.ts' },
    );
  }
  base.push({ ts: clock.t - 5_000, type: 'say', say: 'api_req_started', text: json({ retryStatus: { attempt: 2, maxAttempts: 3, delaySec: 4, errorSnippet: '529 Overloaded' } }) });
  writeText(file, json(base));

  const engine = engineFor(new ClineAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.trouble?.message, '529 Overloaded');
  assert.equal(s.trouble?.attempt, 2);
  assert.equal(s.loop?.label, 'Edit');
  assert.equal(s.loop?.detail, 'src/date.ts');
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.sameError, true);

  writeText(file, json([...base.slice(0, -1), { ts: clock.t - 5_000, type: 'say', say: 'api_req_started', text: json({ tokensIn: 10, tokensOut: 0, cost: 0, cancelReason: 'user_cancelled' }) }]));
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Stopped');

  writeText(file, json([...base, { ts: clock.t - 4_000, type: 'ask', ask: 'api_req_failed', text: '429 Too Many Requests: rate limit exceeded\nretry later' }]));
  s = await only(engine);
  assert.equal(s.status, 'error');
  assert.equal(s.statusDetail, '429 Too Many Requests: rate limit exceeded');

  writeText(file, json([...base, { ts: clock.t - 4_000, type: 'ask', ask: 'mistake_limit_reached', text: 'too many mistakes' }]));
  s = await only(engine);
  assert.equal(s.status, 'error');
  assert.match(s.statusDetail ?? '', /repeated mistakes/);

  // A request in flight that never finished: after a long silence it is stale.
  writeText(file, json([...base.slice(0, -1), { ts: clock.t - 5_000, type: 'say', say: 'api_req_started', text: json({ request: '…' }) }]));
  utimesSync(file, new Date(clock.t - 5_000), new Date(clock.t - 5_000));
  clock.advance(45 * 60_000);
  s = await only(engine);
  assert.equal(s.status, 'stale');
});

test('Roo Code: todo list, cached tokens, questions and a subtask (editor profile)', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const store = path.join(vscodeUserData(home), 'User', 'profiles', '5f1a2b', 'globalStorage', 'rooveterinaryinc.roo-cline');
  const parent = '019a5b2c-0000-7000-8000-000000000001';
  const child = '019a5b2c-0000-7000-8000-000000000002';
  const dir = path.join(store, 'tasks', parent);
  const t0 = clock.t - 300_000;
  writeText(path.join(dir, 'history_item.json'), json({ id: parent, number: 1, ts: t0, task: 'x', tokensIn: 0, tokensOut: 0, totalCost: 0, workspace: '/work/api', mode: 'code' }));
  writeText(
    path.join(dir, 'api_conversation_history.json'),
    json([{ role: 'user', content: [{ type: 'text', text: '<environment_details>\n# Current Mode\n<slug>code</slug>\n<name>Code</name>\n<model>claude-opus-4-5</model>\n</environment_details>' }] }]),
  );
  const todos = [
    { id: 'a', content: 'Write the migration', status: 'completed' },
    { id: 'b', content: 'Update the models', status: 'in_progress' },
    { id: 'c', content: 'Run the tests', status: 'pending' },
  ];
  const messages: any[] = [
    { ts: t0, type: 'say', say: 'text', text: 'Add soft delete to the users table' },
    { ts: t0 + 1_000, type: 'say', say: 'api_req_started', text: json({ apiProtocol: 'anthropic', tokensIn: 15_000, tokensOut: 400, cacheWrites: 2_000, cacheReads: 12_000, cost: 0.03 }) },
    { ts: t0 + 3_000, type: 'ask', ask: 'tool', text: json({ tool: 'updateTodoList', todos }), isAnswered: true },
    { ts: t0 + 4_000, type: 'say', say: 'api_req_started', text: json({ apiProtocol: 'anthropic' }) },
  ];
  writeText(path.join(dir, 'ui_messages.json'), json(messages));

  const engine = engineFor(new RooCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'roo-code');
  assert.equal(s.title, 'Add soft delete to the users table');
  assert.equal(s.projectPath, '/work/api');
  assert.equal(s.model, 'claude-opus-4-5');
  assert.equal(s.status, 'working');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.equal(s.tasks[1]?.title, 'Update the models');
  // Roo counts cached tokens in tokensIn; Kvali's input is the uncached part.
  assert.deepEqual(s.tokens, { input: 1_000, output: 400, cacheRead: 12_000, cacheWrite: 2_000, reasoning: 0 });

  const asked = [...messages, { ts: clock.t - 20_000, type: 'ask', ask: 'followup', text: json({ question: 'Hard or soft cascade?', suggest: [{ answer: 'Soft' }] }) }];
  writeText(path.join(dir, 'ui_messages.json'), json(asked));
  s = await only(engine);
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Asked you a question');

  asked[asked.length - 1].isAnswered = true;
  writeText(path.join(dir, 'ui_messages.json'), json(asked));
  s = await only(engine);
  assert.equal(s.status, 'working');

  // The task hands its work to a subtask: busy while the subtask works.
  const childDir = path.join(store, 'tasks', child);
  writeText(path.join(childDir, 'history_item.json'), json({ id: child, parentTaskId: parent, workspace: '/work/api', status: 'active' }));
  writeText(path.join(childDir, 'ui_messages.json'), json([
    { ts: clock.t - 10_000, type: 'say', say: 'text', text: 'Run the test suite and fix failures' },
    { ts: clock.t - 9_000, type: 'say', say: 'api_req_started', text: json({ apiProtocol: 'anthropic' }) },
  ]));
  writeText(path.join(dir, 'history_item.json'), json({ id: parent, workspace: '/work/api', status: 'delegated', delegatedToId: child, awaitingChildId: child }));
  writeText(path.join(dir, 'ui_messages.json'), json([...asked, { ts: clock.t - 11_000, type: 'ask', ask: 'tool', text: json({ tool: 'newTask', mode: 'code', content: 'Run the tests' }), isAnswered: true }]));
  clock.advance(6_000);
  const snap = await engine.tick();
  const p = snap.sessions.find((x) => x.id === parent);
  const c = snap.sessions.find((x) => x.id === child);
  assert.equal(c?.status, 'working');
  assert.equal(p?.status, 'working');
  assert.equal(p?.statusDetail, 'A subtask is running');
  assert.equal(p?.activeSubagents, 1);
});

test('Cline SDK sessions: status from the manifest, usage from the transcript', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const id = '1762423000000_ab3x9';
  const dir = path.join(home, '.cline', 'data', 'sessions', id);
  const t0 = clock.t - 60_000;
  const manifest = {
    version: 1,
    session_id: id,
    source: 'vscode',
    pid: process.pid,
    started_at: new Date(t0).toISOString(),
    status: 'running',
    interactive: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    cwd: '/work/site/web',
    workspace_root: '/work/site',
    metadata: { title: 'Make the header sticky', usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } },
  };
  writeText(path.join(dir, `${id}.json`), json(manifest));
  const fail = (n: number) => [
    { id: `a${n}`, role: 'assistant', ts: t0 + n * 1_000, modelInfo: { id: 'anthropic/claude-sonnet-4.5' }, content: [{ type: 'tool_use', id: `t${n}`, name: 'run_commands', input: { commands: ['pnpm build'] } }], metrics: { inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 9_000, cacheWriteTokens: 500, cost: 0.004 } },
    { id: `u${n}`, role: 'user', ts: t0 + n * 1_000 + 500, content: [{ type: 'tool_result', tool_use_id: `t${n}`, name: 'run_commands', content: [{ query: 'pnpm build', result: 'error TS2304', success: false, error: 'Command exited with code 2' }] }] },
  ];
  writeText(path.join(dir, `${id}.messages.json`), json({
    version: 1,
    sessionId: id,
    messages: [
      { id: 'm0', role: 'user', ts: t0, content: [{ type: 'text', text: '<user_input mode="act">Make the header sticky</user_input>' }] },
      ...fail(1),
      ...fail(2),
      ...fail(3),
      ...fail(4),
    ],
  }));

  const engine = engineFor(new ClineAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'cline');
  assert.equal(s.id, id);
  assert.equal(s.title, 'Make the header sticky');
  assert.equal(s.projectPath, '/work/site');
  assert.equal(s.cwd, '/work/site/web');
  assert.equal(s.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Shell');
  assert.equal(s.activity?.detail, 'pnpm build');
  assert.deepEqual(s.tokens, { input: 2_000, output: 400, cacheRead: 36_000, cacheWrite: 2_000, reasoning: 0 });
  assert.equal(Math.round((s.costUsd ?? 0) * 1000), 16);
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.detail, 'pnpm build');

  // The editor that ran it is gone: the session is not working any more.
  writeText(path.join(dir, `${id}.json`), json({ ...manifest, pid: 2 ** 22 + 12_345 }));
  clock.advance(10_000);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Cline was closed');

  writeText(path.join(dir, `${id}.json`), json({ ...manifest, status: 'completed', ended_at: clock.iso(0) }));
  clock.advance(10_000);
  s = await only(engine);
  assert.equal(s.status, 'done');
});
