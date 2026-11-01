import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { AntigravityAdapter } from '../src/adapters/antigravity.ts';
import { progressOf } from '../src/model.ts';
import { Clock, appendJsonl, engineFor, only, tmpHome, writeJsonl, writeText } from './helpers.ts';

const CONV = '9923418a-abe1-4238-9ef2-a3271d82d117';

/** Antigravity stores every tool argument as a JSON-encoded string. */
function call(name: string, args: Record<string, unknown>) {
  return { name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) };
}

test('Antigravity: task.md progress, toolAction activity, project detection and waiting', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.gemini', 'antigravity-ide', 'brain', CONV);
  writeText(
    path.join(dir, 'task.md'),
    `# Code Audit — Task Tracker

## Phase 1: Dead code
- [x] Delete \`src/components/old.tsx\`
- [x] Delete \`src/hooks/use-legacy.ts\`

## Phase 2: Refactor
- [/] Refactor \`appStore.ts\`
- [ ] Type check
- [-] Skipped item
`,
  );
  writeText(path.join(dir, 'task.md.metadata.json'), JSON.stringify({ artifactType: 'ARTIFACT_TYPE_TASK', summary: 'Audit in progress', updatedAt: clock.iso(0) }));
  const transcript = path.join(dir, '.system_generated', 'logs', 'transcript.jsonl');
  const step = (i: number, extra: Record<string, unknown>) => ({ step_index: i, created_at: clock.iso(i * 1_000).replace(/\.\d+Z$/, 'Z'), status: 'DONE', ...extra });

  writeJsonl(transcript, [
    step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Audit the shop app and remove dead code' }),
    step(1, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Listing the workspace', tool_calls: [call('list_dir', { DirectoryPath: '/work/shop', toolAction: 'Listing the workspace directory' })] }),
    step(2, { source: 'MODEL', type: 'LIST_DIRECTORY', content: '…' }),
    step(3, {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Running type check',
      tool_calls: [call('run_command', { CommandLine: 'pnpm check-types', Cwd: '/work/shop', toolAction: 'Running pnpm check-types' })],
    }),
    step(4, { source: 'MODEL', type: 'RUN_COMMAND', status: 'RUNNING', content: '' }),
  ]);
  clock.advance(5_000);

  const engine = engineFor(new AntigravityAdapter(), home, clock);
  let s = await only(engine);
  assert.equal(s.agent, 'antigravity');
  assert.equal(s.title, 'Code Audit');
  assert.equal(s.titleFromPrompt, undefined, 'the task list title');
  assert.equal(s.projectPath, '/work/shop');
  assert.equal(s.status, 'working');
  assert.equal(s.activity?.label, 'Running pnpm check-types');
  assert.equal(s.activity?.detail, 'pnpm check-types');
  assert.deepEqual(progressOf(s.tasks), { done: 2, inProgress: 1, total: 4, percent: 50 });
  assert.equal(s.tasks[2].group, 'Phase 2: Refactor');
  assert.equal(s.tokens, undefined);

  appendJsonl(transcript, [
    step(10, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'May I delete the folder?', tool_calls: [call('ask_permission', { Action: 'delete', Target: '/work/shop/dist', toolAction: 'Asking permission' })] }),
  ]);
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.status, 'waiting');
  assert.equal(s.statusDetail, 'Needs your permission');

  appendJsonl(transcript, [
    step(12, { source: 'SYSTEM', type: 'GENERIC', content: 'approved' }),
    step(13, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'All done.' }),
  ]);
  writeText(path.join(dir, 'task.md'), '# Code Audit\n- [x] a\n- [x] b\n');
  clock.advance(1_000);
  s = await only(engine);
  assert.equal(s.status, 'done');
});

test('Antigravity: a silent conversation is reported as paused, not working', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.gemini', 'antigravity', 'brain', CONV);
  writeJsonl(path.join(dir, '.system_generated', 'logs', 'transcript.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: clock.iso(0), content: 'Hello' },
    { step_index: 1, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: clock.iso(1_000), content: '…' },
  ]);
  clock.advance(10 * 60_000);
  const s = await only(engineFor(new AntigravityAdapter(), home, clock));
  assert.equal(s.status, 'idle');
  assert.equal(s.statusDetail, 'Paused');
  assert.equal(s.title, 'Hello');
});

test('Antigravity: tagged user input gives the title, model and project (no git repo)', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const dir = path.join(home, '.gemini', 'antigravity-ide', 'brain', CONV);
  const input = [
    '<USER_REQUEST>',
    'Add a dark mode toggle to the settings screen',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    'The current local time is: 2026-10-30T14:00:00+04:00.',
    "The user's current state is as follows:",
    'Active Document: /data/apps/fitness/src/screens/Settings.tsx (LANGUAGE_TYPESCRIPT_REACT)',
    'Cursor is on line: 12',
    '</ADDITIONAL_METADATA>',
    '<USER_SETTINGS_CHANGE>',
    'The user changed setting `Model Selection` from None to Gemini 3.1 Pro (High). No need to comment on this change.',
    '</USER_SETTINGS_CHANGE>',
  ].join('\n');
  writeJsonl(path.join(dir, '.system_generated', 'logs', 'transcript.jsonl'), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: clock.iso(0), content: input },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: clock.iso(1_000), tool_calls: [call('view_file', { AbsolutePath: '/data/apps/fitness/src/theme/colors.ts', toolAction: 'Reading colors' })] },
    { step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', created_at: clock.iso(1_500) },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: clock.iso(2_000), tool_calls: [call('view_file', { AbsolutePath: '/data/apps/fitness/src/screens/Home.tsx', toolAction: 'Reading home' })] },
  ]);
  clock.advance(10_000);
  const s = await only(engineFor(new AntigravityAdapter(), home, clock));
  assert.equal(s.title, 'Add a dark mode toggle to the settings screen');
  assert.equal(s.titleFromPrompt, true);
  assert.equal(s.model, 'Gemini 3.1 Pro (High)');
  assert.equal(s.projectPath, '/data/apps/fitness/src', 'common ancestor of the folders the agent used');
  assert.equal(s.activity?.label, 'Reading home');
});
