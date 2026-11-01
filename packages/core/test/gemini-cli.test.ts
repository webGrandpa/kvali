import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { GeminiCliAdapter } from '../src/adapters/gemini-cli.ts';
import { progressOf } from '../src/model.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl, writeText } from './helpers.ts';

test('Gemini CLI: JSONL sessions with patches, todos and tokens', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const projDir = path.join(home, '.gemini', 'tmp', 'web-app-3f2a');
  writeText(path.join(projDir, '.project_root'), '/work/web-app\n');
  const file = path.join(projDir, 'chats', 'session-2026-10-30T10-00-ab12cd34.jsonl');

  writeJsonl(file, [
    { sessionId: 'ab12cd34-0000', projectHash: 'f00', startTime: clock.iso(0), lastUpdated: clock.iso(0), kind: 'main' },
    { id: 'm1', timestamp: clock.iso(1), type: 'user', content: [{ text: 'Migrate the router to the new API' }] },
    {
      id: 'm2',
      timestamp: clock.iso(2_000),
      type: 'gemini',
      model: 'gemini-3-pro',
      content: [{ text: 'Planning the migration.' }],
      tokens: { input: 20_000, output: 500, cached: 15_000, thoughts: 200, tool: 0, total: 20_700 },
      toolCalls: [
        {
          id: 't1',
          name: 'write_todos',
          status: 'success',
          timestamp: clock.iso(2_000),
          args: {
            todos: [
              { description: 'Inventory routes', status: 'completed' },
              { description: 'Rewrite loaders', status: 'in_progress' },
              { description: 'Remove legacy router', status: 'pending' },
            ],
          },
        },
        { id: 't2', name: 'run_shell_command', displayName: 'Shell', description: 'npm run typecheck', status: 'executing', timestamp: clock.iso(2_100), args: {} },
      ],
    },
  ]);
  clock.advance(5_000);

  const engine = engineFor(new GeminiCliAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'gemini-cli');
  assert.equal(s.projectPath, '/work/web-app');
  assert.equal(s.title, 'Migrate the router to the new API');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Shell');
  assert.deepEqual(progressOf(s.tasks), { done: 1, inProgress: 1, total: 3, percent: 33 });
  assert.deepEqual(s.tokens, { input: 5_000, output: 700, cacheRead: 15_000, cacheWrite: 0, reasoning: 200 });
  assert.equal(s.costUsd, undefined, 'no built-in Gemini prices: cost stays unknown');

  // A patch updates the earlier tool call; a final answer ends the turn.
  appendJsonl(file, [
    { $patch: { id: 'm2', toolCalls: [{ id: 't2', status: 'success', result: [{ text: 'ok' }] }] } },
    {
      id: 'm3',
      timestamp: clock.iso(1_000),
      type: 'gemini',
      model: 'gemini-3-pro',
      content: [{ text: 'Done.' }],
      tokens: { input: 21_000, output: 100, cached: 20_000, thoughts: 0, total: 21_100 },
    },
    { $set: { summary: 'Router migration' } },
  ]);
  clock.advance(2_000);
  s = await only(engine);
  assert.equal(s.title, 'Router migration');
  assert.equal(s.titleFromPrompt, undefined, "Gemini's summary");
  assert.equal(s.status, 'idle');
  assert.equal(s.tokens?.cacheRead, 35_000);

  appendJsonl(file, [{ $rewindTo: 'm3' }]);
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.tokens?.cacheRead, 15_000, 'rewind drops the rewound message');
});

test('Gemini CLI: awaiting approval is reported as waiting', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const file = path.join(home, '.gemini', 'tmp', 'p', 'chats', 'session-x.jsonl');
  writeJsonl(file, [
    { sessionId: 's', projectHash: 'h', startTime: clock.iso(0) },
    { id: 'u', timestamp: clock.iso(0), type: 'user', content: 'Delete the build folder' },
    { id: 'g', timestamp: clock.iso(1), type: 'gemini', content: '', toolCalls: [{ id: 'c', name: 'run_shell_command', displayName: 'Shell', status: 'awaiting_approval', args: {} }] },
  ]);
  clock.advance(1_000);
  const s = await only(engineFor(new GeminiCliAdapter(), home, clock));
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Needs approval: Shell');
});
