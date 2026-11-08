import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CopilotAdapter, parseWorkspaceYaml } from '../src/adapters/copilot.ts';
import { progressOf } from '../src/model.ts';
import { sqliteModule } from '../src/util/sqlite.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl, writeText } from './helpers.ts';

const ev = (clock: Clock, offset: number, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  type,
  data,
  id: `${type}-${offset}-${Math.random().toString(36).slice(2, 8)}`,
  timestamp: clock.iso(offset),
  parentId: null,
  ...extra,
});

test('Copilot CLI: a permission prompt, the plan, usage, a failing command, the end of the turn', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const id = '6b1f7c2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';
  const dir = path.join(home, '.copilot', 'session-state', id);
  const file = path.join(dir, 'events.jsonl');
  writeText(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: /work/svc\ngit_root: /work/svc\nname: "Upgrade the HTTP client"\nuser_named: false\nclient_name: copilot-cli\n`);
  writeText(path.join(dir, `inuse.${process.pid}.lock`), '');
  writeJsonl(file, [
    ev(clock, -60_000, 'session.start', { sessionId: id, version: 1, producer: 'copilot-agent', copilotVersion: '1.0.106', startTime: clock.iso(-60_000), selectedModel: 'claude-sonnet-4.5', context: { cwd: '/work/svc', gitRoot: '/work/svc' } }),
    ev(clock, -59_000, 'user.message', { content: 'Upgrade the HTTP client and fix the tests', delivery: 'idle', agentMode: 'interactive' }),
    ev(clock, -58_000, 'assistant.turn_start', { turnId: '1', model: 'claude-sonnet-4.5' }),
    ev(clock, -55_000, 'assistant.message', { messageId: 'm1', content: 'Planning.', toolRequests: [{ toolCallId: 't1', name: 'update_todo', arguments: {} }] }),
    ev(clock, -55_000, 'tool.execution_start', { toolCallId: 't1', toolName: 'update_todo', arguments: { todos: '- [x] Read the client\n- [-] Upgrade it\n- [ ] Fix the tests' } }),
    ev(clock, -54_900, 'tool.execution_complete', { toolCallId: 't1', success: true, result: { content: 'TODO list updated' } }),
    ev(clock, -54_800, 'session.usage_record', { usage: { model: 'claude-sonnet-4.5', inputTokens: 20_000, outputTokens: 500, cacheReadTokens: 18_000, cacheWriteTokens: 1_000, reasoningTokens: 100, cost: 1, duration: 3_000 } }),
    ev(clock, -54_700, 'assistant.turn_end', { turnId: '1' }),
    ev(clock, -54_600, 'assistant.turn_start', { turnId: '2' }),
    ev(clock, -50_000, 'assistant.message', { messageId: 'm2', content: '', toolRequests: [{ toolCallId: 't2', name: 'bash', arguments: {} }] }),
    ev(clock, -50_000, 'tool.execution_start', { toolCallId: 't2', toolName: 'bash', arguments: { command: 'npm test', description: 'Run the tests', mode: 'sync' } }),
    ev(clock, -49_900, 'permission.requested', { requestId: 'p1', permissionRequest: { kind: 'shell', toolCallId: 't2', fullCommandText: 'npm test', intention: 'Run the tests' }, permissionMode: 'manual' }),
    // A subagent's events are its own.
    ev(clock, -49_800, 'tool.execution_start', { toolCallId: 's1', toolName: 'grep', arguments: { pattern: 'fetch(' } }, { agentId: 'sub-1' }),
  ]);
  clock.advance(1_000);

  const engine = engineFor(new CopilotAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'copilot');
  assert.equal(s.title, 'Upgrade the HTTP client');
  assert.equal(s.titleFromPrompt, undefined);
  assert.equal(s.projectPath, '/work/svc');
  assert.equal(s.agentVersion, '1.0.106');
  assert.equal(s.model, 'claude-sonnet-4.5');
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Needs approval: run npm test');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.deepEqual(s.tokens, { input: 1_000, output: 500, cacheRead: 18_000, cacheWrite: 1_000, reasoning: 100 });
  assert.ok((s.costUsd ?? 0) > 0, 'priced at Anthropic list prices');

  // Approved; the command keeps failing the same way.
  const fails = [];
  for (let i = 0; i < 4; i += 1) {
    if (i > 0) fails.push(ev(clock, -40_000 + i * 5_000, 'tool.execution_start', { toolCallId: `t2-${i}`, toolName: 'bash', arguments: { command: 'npm test' } }));
    fails.push(
      ev(clock, -39_000 + i * 5_000, 'tool.execution_complete', {
        toolCallId: i === 0 ? 't2' : `t2-${i}`,
        success: true,
        result: { content: 'FAIL client.spec.ts\n1 failing', contents: [{ type: 'shell_exit', shellId: 'x', exitCode: 1 }] },
      }),
    );
  }
  appendJsonl(file, [ev(clock, -45_000, 'permission.completed', { requestId: 'p1', result: { kind: 'approved' } }), ...fails]);
  s = await only(engine);
  assert.equal(s.status, 'working');
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.sameError, true);
  assert.equal(s.loop?.detail, 'npm test');

  // The model answers without asking for tools: the turn is over.
  appendJsonl(file, [ev(clock, -10_000, 'assistant.message', { messageId: 'm3', content: 'The tests still fail; here is why.' }), ev(clock, -9_000, 'assistant.turn_end', { turnId: '3' })]);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.loop, undefined);

  appendJsonl(file, [ev(clock, -5_000, 'user.message', { content: 'Try again' }), ev(clock, -4_000, 'assistant.turn_start', { turnId: '4' }), ev(clock, -3_000, 'session.error', { errorType: 'rate_limit', message: 'You have exceeded your rate limit.' })]);
  s = await only(engine);
  assert.equal(s.status, 'error');
  assert.equal(s.statusDetail, 'You have exceeded your rate limit.');

  appendJsonl(file, [ev(clock, -2_000, 'user.message', { content: 'Go on' }), ev(clock, -1_500, 'assistant.turn_start', { turnId: '5' }), ev(clock, -1_000, 'abort', { reason: 'user_initiated' })]);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Stopped');
});

test('Copilot CLI: a crashed process, the todo table, the prompt as the title', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const id = '0c0c0c0c-1111-4222-8333-444455556666';
  const dir = path.join(home, '.copilot', 'session-state', id);
  const file = path.join(dir, 'events.jsonl');
  writeJsonl(file, [
    ev(clock, -30_000, 'session.start', { sessionId: id, copilotVersion: '1.0.106', startTime: clock.iso(-30_000), context: { cwd: '/work/docs' } }),
    ev(clock, -29_000, 'user.message', { content: 'Rewrite the install guide for Windows' }),
    ev(clock, -28_000, 'assistant.turn_start', { turnId: '1' }),
  ]);
  writeText(path.join(dir, 'inuse.4194303.lock'), '');
  if (sqliteModule()) {
    const db = new (sqliteModule()!.DatabaseSync)(path.join(dir, 'session.db'));
    db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
    const ins = db.prepare('INSERT INTO todos (id, title, status, created_at) VALUES (?,?,?,?)');
    ins.run('a', 'Outline', 'done', '2026-11-06 09:59:00');
    ins.run('b', 'Write the steps', 'in_progress', '2026-11-06 09:59:01');
    db.close();
  }
  const engine = engineFor(new CopilotAdapter(), home, clock);
  const s = await only(engine);
  assert.equal(s.title, 'Rewrite the install guide for Windows');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.projectPath, '/work/docs');
  // The only process that had it open is gone.
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Copilot was closed');
  if (sqliteModule()) assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 2, percent: 50 });
});

test('Copilot: workspace.yaml values', () => {
  const y = parseWorkspaceYaml('id: abc\ncwd: /home/me/My Project\nname: "Fix \\"the\\" bug"\nsummary: |\n  multi\nbranch: null\nother: \'it\'\'s\'\n');
  assert.equal(y.cwd, '/home/me/My Project');
  assert.equal(y.name, 'Fix "the" bug');
  assert.equal(y.summary, undefined);
  assert.equal(y.branch, undefined);
  assert.equal(y.other, "it's");
});
