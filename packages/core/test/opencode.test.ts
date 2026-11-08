import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { KiloCodeAdapter, OpenCodeAdapter } from '../src/adapters/opencode.ts';
import { progressOf } from '../src/model.ts';
import { sqliteModule } from '../src/util/sqlite.ts';
import { Clock, engineFor, only, tmpHome } from './helpers.ts';

const sqlite = sqliteModule();
const skip = sqlite ? false : 'node:sqlite is not available in this Node';
const json = (v: unknown) => JSON.stringify(v);

function openDb(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite!.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

const V2_SCHEMA = `
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text, parent_id text, directory text NOT NULL, title text, version text, cost real DEFAULT 0,
  tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0, tokens_reasoning integer DEFAULT 0, tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0,
  revert text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_busy integer, time_idle integer, idle_outcome text,
  time_suspended integer, time_archived integer);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, call_id text, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

test('OpenCode 2.x: busy sessions, tool calls in parts, todos, loops, the end of a turn', { skip }, async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const db = openDb(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  db.exec(V2_SCHEMA);
  const t0 = clock.t - 300_000;
  const sid = 'ses_7f3a';
  const model = { id: 'claude-sonnet-4-5', providerID: 'anthropic' };
  db.prepare('INSERT INTO session_v2 (id, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, model, time_created, time_updated, time_busy, time_suspended) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    sid, '/work/app', 'Fix the flaky login test', '2.2.5', 0.42, 3_000, 900, 100, 40_000, 2_000, json(model), t0, clock.t - 5_000, t0 + 1_000, t0 + 1_000,
  );
  const msg = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  const todos = [
    { content: 'Reproduce the failure', status: 'completed' },
    { content: 'Fix the race', status: 'in_progress' },
    { content: 'Run the suite', status: 'pending' },
  ];
  msg.run('msg_001', sid, 'user', 1, t0 + 1_000, t0 + 1_000, json({ text: 'The login test fails one run in five', time: { created: t0 + 1_000 } }));
  msg.run('msg_002', sid, 'assistant', 2, t0 + 2_000, t0 + 20_000, json({
    agent: 'build', model, content: [
      { type: 'text', text: 'Planning.' },
      { type: 'tool', id: 'call_1', name: 'todowrite', state: { status: 'completed', input: { todos }, content: [{ type: 'text', text: 'ok' }] }, time: { created: t0 + 3_000, completed: t0 + 3_100 } },
    ],
    finish: 'tool-calls', cost: 0.2, tokens: { input: 1_500, output: 400, reasoning: 50, cache: { read: 20_000, write: 2_000 } }, time: { created: t0 + 2_000, completed: t0 + 20_000 },
  }));
  // The same command failing four times with the same error, then a step in progress.
  for (let i = 0; i < 4; i += 1) {
    const at = t0 + 30_000 + i * 10_000;
    msg.run(`msg_00${3 + i}`, sid, 'assistant', 3 + i, at, at + 5_000, json({
      agent: 'build', model, content: [
        { type: 'tool', id: `call_t${i}`, name: 'shell', state: { status: 'completed', input: { command: 'pnpm test login' }, content: [{ type: 'text', text: 'FAIL login.spec.ts\nExited with code 1' }], metadata: { status: 'completed', exit: 1 } }, time: { created: at, ran: at, completed: at + 4_000 } },
      ],
      cost: 0.05, tokens: { input: 300, output: 100, reasoning: 0, cache: { read: 5_000, write: 0 } }, time: { created: at, completed: at + 5_000 },
    }));
  }
  msg.run('msg_007', sid, 'assistant', 7, clock.t - 6_000, clock.t - 5_000, json({ agent: 'build', model, content: [], time: { created: clock.t - 6_000 } }));
  db.prepare('INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?,?)').run(
    'msg_007', sid, 0, 'tool', 'call_x', clock.t - 5_500, clock.t - 5_000,
    json({ type: 'tool', id: 'call_x', name: 'bash', state: { status: 'running', input: { command: 'pnpm test login --repeat 20' }, metadata: {} }, time: { created: clock.t - 5_500, ran: clock.t - 5_400 } }),
  );

  const engine = engineFor(new OpenCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'opencode');
  assert.equal(s.title, 'Fix the flaky login test');
  assert.equal(s.titleFromPrompt, undefined);
  assert.equal(s.projectPath, '/work/app');
  assert.equal(s.model, 'claude-sonnet-4-5');
  assert.equal(s.agentVersion, '2.2.5');
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Shell');
  assert.equal(s.activity?.detail, 'pnpm test login --repeat 20');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.deepEqual(s.tokens, { input: 3_000, output: 1_000, cacheRead: 40_000, cacheWrite: 2_000, reasoning: 100 });
  assert.equal(s.costUsd, 0.42);
  assert.equal(s.loop?.count, 4);
  assert.equal(s.loop?.detail, 'pnpm test login');
  assert.equal(s.turn?.steps, 6);

  // The turn ends.
  const end = clock.t + 1_000;
  clock.advance(10_000);
  db.prepare("UPDATE session_v2 SET time_idle = ?, idle_outcome = 'succeeded', time_suspended = NULL, time_updated = ? WHERE id = ?").run(end, end, sid);
  db.prepare("UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'msg_007'").run(json({ agent: 'build', model, content: [], finish: 'stop', time: { created: clock.t - 16_000, completed: end } }), end);
  msg.run('msg_008', sid, 'idle', 8, end, end, json({ outcome: 'succeeded', time: { created: end } }));
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.loop, undefined);

  // A failed turn.
  clock.advance(10_000);
  db.prepare("UPDATE session_v2 SET time_busy = ?, time_idle = ?, idle_outcome = 'failed', time_updated = ? WHERE id = ?").run(clock.t - 3_000, clock.t - 1_000, clock.t - 1_000, sid);
  msg.run('msg_009', sid, 'idle', 9, clock.t - 1_000, clock.t - 1_000, json({ outcome: 'failed', error: { type: 'provider.rate-limit', message: 'Rate limit reached for claude-sonnet-4-5' }, time: { created: clock.t - 1_000 } }));
  s = await only(engine);
  assert.equal(s.status, 'error');
  assert.equal(s.statusDetail, 'Rate limit reached for claude-sonnet-4-5');
  db.close();
});

test('OpenCode 2.x: an open permission prompt, from the local service', { skip }, async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const db = openDb(path.join(home, '.local', 'share', 'opencode', 'opencode.db'));
  db.exec(V2_SCHEMA);
  const sid = 'ses_9b';
  db.prepare('INSERT INTO session_v2 (id, directory, title, time_created, time_updated, time_busy) VALUES (?,?,?,?,?,?)').run(sid, '/work/api', 'Clean the build', clock.t - 60_000, clock.t - 2_000, clock.t - 50_000);
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)').run(
    'msg_1', sid, 'assistant', 1, clock.t - 40_000, clock.t - 2_000,
    json({ agent: 'build', model: { id: 'gpt-5.5', providerID: 'openai' }, content: [{ type: 'tool', id: 'c1', name: 'shell', state: { status: 'running', input: { command: 'rm -rf dist' }, metadata: {} }, time: { created: clock.t - 3_000, ran: clock.t - 2_900 } }], time: { created: clock.t - 40_000 } }),
  );
  const seen: { url?: string; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === `/api/session/${sid}/permission`) res.end(json({ data: [{ id: 'per_1', sessionID: sid, action: 'bash', resources: ['rm -rf dist'] }] }));
    else res.end(json({ data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(path.join(home, '.local', 'state', 'opencode'), { recursive: true });
  writeFileSync(path.join(home, '.local', 'state', 'opencode', 'service.json'), json({ id: 'x', version: '2.2.5', url: `http://127.0.0.1:${port}`, pid: process.pid, password: 'secret' }));
  try {
    const engine = engineFor(new OpenCodeAdapter(), home, clock);
    let s = await only(engine);
    assert.equal(s.status, 'working');
    // The answer arrives in the background and is used on the next poll.
    await new Promise((r) => setTimeout(r, 300));
    clock.advance(3_000);
    s = await only(engine);
    assert.equal(s.status, 'waiting');
    assert.equal(s.statusDetail, 'Needs approval: bash rm -rf dist');
    assert.equal(seen[0]?.auth, `Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    assert.ok(seen.every((r) => r.url?.startsWith(`/api/session/${sid}/`)));
  } finally {
    server.close();
    db.close();
  }
});

test('Kilo Code (OpenCode 1.x layout): parts, the todo table, an untitled session, a stopped step', { skip }, async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T10:00:00.000Z');
  const db = openDb(path.join(home, '.local', 'share', 'kilo', 'kilo.db'));
  db.exec(`
    CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, slug text, directory text NOT NULL, title text NOT NULL, version text NOT NULL, cost real DEFAULT 0,
      tokens_input integer DEFAULT 0, tokens_output integer DEFAULT 0, tokens_reasoning integer DEFAULT 0, tokens_cache_read integer DEFAULT 0, tokens_cache_write integer DEFAULT 0,
      revert text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL, priority text NOT NULL, position integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, PRIMARY KEY (session_id, position));
  `);
  const t0 = clock.t - 120_000;
  const sid = 'ses_k1';
  db.prepare('INSERT INTO session (id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?)').run(sid, 'calm-fox', '/work/kilo-app', 'New session - 2026-11-06T09:58:00.000Z', '7.8.27', t0, clock.t - 4_000);
  const msg = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
  const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
  msg.run('msg_a1', sid, t0, t0, json({ role: 'user', time: { created: t0 }, agent: 'code', model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4.5' } }));
  part.run('prt_a1', 'msg_a1', sid, t0, t0, json({ type: 'text', text: 'Add pagination to the orders endpoint' }));
  const assistant = (completed?: number, error?: unknown) =>
    json({
      role: 'assistant', time: { created: t0 + 1_000, ...(completed ? { completed } : {}) }, ...(error ? { error } : {}), parentID: 'msg_a1',
      modelID: 'anthropic/claude-sonnet-4.5', providerID: 'kilo', mode: 'code', agent: 'code', path: { cwd: '/work/kilo-app', root: '/work/kilo-app' },
      cost: 0.12, tokens: { input: 2_000, output: 500, reasoning: 0, cache: { read: 10_000, write: 1_000 } },
    });
  msg.run('msg_a2', sid, t0 + 1_000, clock.t - 4_000, assistant());
  part.run('prt_a2', 'msg_a2', sid, t0 + 2_000, clock.t - 4_000, json({ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'running', input: { command: 'npm run migrate' }, time: { start: clock.t - 4_000 } } }));
  const todo = db.prepare('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?,?,?,?,?,?,?)');
  todo.run(sid, 'Add the query params', 'completed', 'high', 0, t0, t0 + 5_000);
  todo.run(sid, 'Write the tests', 'in_progress', 'medium', 1, t0, t0 + 5_000);

  const engine = engineFor(new KiloCodeAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'kilo-code');
  assert.equal(s.agentLabel, 'Kilo Code');
  assert.equal(s.title, 'Add pagination to the orders endpoint');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.detail, 'npm run migrate');
  assert.equal(s.model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 2, percent: 50 });
  assert.deepEqual(s.tokens, { input: 2_000, output: 500, cacheRead: 10_000, cacheWrite: 1_000, reasoning: 0 });

  clock.advance(5_000);
  db.prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?').run(assistant(clock.t - 1_000), clock.t - 1_000, 'msg_a2');
  db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(json({ type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'npm run migrate' }, output: 'ok', title: 'migrate', metadata: { exit: 0 }, time: { start: clock.t - 9_000, end: clock.t - 2_000 } } }), clock.t - 1_000, 'prt_a2');
  db.prepare("UPDATE todo SET status = 'completed', time_updated = ? WHERE session_id = ? AND position = 1").run(clock.t - 1_000, sid);
  db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(clock.t - 1_000, sid);
  s = await only(engine);
  assert.equal(s.status, 'done');

  clock.advance(5_000);
  db.prepare('UPDATE message SET data = ?, time_updated = ? WHERE id = ?').run(assistant(clock.t - 1_000, { name: 'MessageAbortedError', data: { message: 'Aborted' } }), clock.t - 1_000, 'msg_a2');
  db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(clock.t - 1_000, sid);
  s = await only(engine);
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Stopped');
  db.close();
});
