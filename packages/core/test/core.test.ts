import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProgressFileAdapter } from '../src/adapters/progress-file.ts';
import { fmtTokens, fmtUsd, groupByProject, pathWithin } from '../src/format.ts';
import { claudeHookCommand, claudeHooksStatus, installClaudeHooks, uninstallClaudeHooks } from '../src/hooks/claude-install.ts';
import { HookHub, normalizeHookPayload } from '../src/hooks/hub.ts';
import type { AgentSession } from '../src/model.ts';
import { progressOf } from '../src/model.ts';
import { Pricing, anthropicModelKey } from '../src/pricing.ts';
import { addProgressProtocol, PROGRESS_PROTOCOL_MARKER } from '../src/protocol.ts';
import { parseChecklist } from '../src/util/checklist.ts';
import { JsonlTail } from '../src/util/jsonl.ts';
import { Clock, engineFor, only, tmpHome, writeText } from './helpers.ts';

test('JsonlTail consumes only complete lines and survives truncation', async () => {
  const file = path.join(tmpHome(), 'x.jsonl');
  writeFileSync(file, '{"a":1}\n{"b":');
  const tail = new JsonlTail(file);
  const seen: any[] = [];
  await tail.read((r) => seen.push(r));
  assert.deepEqual([...seen], [{ a: 1 }]);
  appendFileSync(file, '2}\nnot json\n{"c":"ünï"}\n');
  await tail.read((r) => seen.push(r));
  assert.deepEqual([...seen], [{ a: 1 }, { b: 2 }, { c: 'ünï' }]);
  writeFileSync(file, '{"d":4}\n');
  let reset = false;
  await tail.read(
    (r) => seen.push(r),
    () => {
      reset = true;
    },
  );
  assert.ok(reset);
  assert.deepEqual(seen.at(-1), { d: 4 });
});

test('parseChecklist understands markers, groups, front matter and code fences', () => {
  const parsed = parseChecklist(`---
agent: Cursor
status: working
---
# Ship v2
## Backend
- [x] API
  - [/] Nested step
\`\`\`md
- [ ] not a task (inside a fence)
\`\`\`
1. [ ] Numbered
- [!] Blocked one
- [-] Dropped
`);
  assert.equal(parsed.title, 'Ship v2');
  assert.equal(parsed.frontmatter.agent, 'Cursor');
  assert.deepEqual(
    parsed.tasks.map((t) => [t.title, t.status, t.depth, t.group]),
    [
      ['API', 'completed', 0, 'Backend'],
      ['Nested step', 'in_progress', 1, 'Backend'],
      ['Numbered', 'pending', 0, 'Backend'],
      ['Blocked one', 'blocked', 0, 'Backend'],
      ['Dropped', 'cancelled', 0, 'Backend'],
    ],
  );
  assert.deepEqual(progressOf(parsed.tasks), { done: 1, inProgress: 1, total: 4, percent: 25 });
});

test('anthropicModelKey normalizes API, Bedrock and legacy ids', () => {
  const cases: [string, string | undefined][] = [
    ['claude-opus-5-5', 'opus-5-5'],
    ['claude-opus-4-5-20251101', 'opus-4-5'],
    ['claude-opus-4-20250514', 'opus-4'],
    ['claude-sonnet-4-6', 'sonnet-4-6'],
    ['claude-3-5-haiku-20241022', 'haiku-3-5'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'sonnet-4-5'],
    ['claude-haiku-4-5@20251001', 'haiku-4-5'],
    ['claude-opus-5-5[1m]', 'opus-5-5'],
    ['gpt-5.5-codex', undefined],
  ];
  for (const [input, want] of cases) assert.equal(anthropicModelKey(input), want, input);
});

test('Pricing applies cache tiers, long-prompt tiers, fast mode and custom globs', () => {
  const pricing = new Pricing({ 'gemini-3-*': { input: 2, output: 12, cacheRead: 0.2 } });
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  assert.equal(pricing.cost('claude-opus-5-5', u), 4);
  assert.equal(pricing.cost('claude-opus-5-5', { ...u, speed: 'fast' }), 8);
  assert.equal(pricing.cost('claude-haiku-5-5', { ...u, input: 50_000 }), 0.005);
  assert.equal(pricing.cost('claude-haiku-5-5', { ...u, input: 200_000 }), 0.1, 'long-prompt tier above 100k');
  assert.equal(pricing.cost('claude-sonnet-4-5', { ...u, input: 0, cacheWrite5m: 1_000_000 }), 3.75);
  assert.equal(pricing.cost('gemini-3-pro', { ...u, output: 1_000_000, input: 0 }), 12);
  assert.equal(pricing.cost('unknown-model', u), undefined);
});

test('format helpers', () => {
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(12_300), '12k');
  assert.equal(fmtTokens(1_234_000), '1.23M');
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(3.456), '$3.46');
  assert.ok(pathWithin('/a/b/c', '/a/b'));
  assert.ok(!pathWithin('/a/bc', '/a/b'));
  assert.ok(pathWithin('C:\\Work\\App\\src', 'c:/work/app'));

  const s = (key: string, projectPath: string, updatedAt: number): AgentSession => ({
    key,
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    id: key,
    title: key,
    projectPath,
    status: 'idle',
    startedAt: 0,
    updatedAt,
    tasks: [],
    sources: [],
  });
  const groups = groupByProject([s('1', '/w/api', 5), s('2', '/w/web/packages/ui', 9), s('3', '/w/web', 1)], ['/w/web'], Date.now());
  assert.deepEqual(
    groups.map((g) => [g.name, g.inWorkspace, g.sessions.length]),
    [
      ['web', true, 2],
      ['api', false, 1],
    ],
  );
});

test('Progress file protocol: front matter, derived status and staleness', async () => {
  const home = tmpHome();
  const root = path.join(home, 'repo');
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  writeText(path.join(root, '.agents', 'progress.md'), '---\nagent: Cursor\n---\n# Dark mode\n- [x] Tokens\n- [/] Components\n- [ ] Docs\n');
  writeText(path.join(root, '.agents', 'progress', 'copilot.md'), '---\nagent: Copilot\nstatus: waiting\nnote: Which palette?\n---\n# Palette\n- [ ] Pick\n');
  clock.t = Date.now();
  const engine = engineFor(new ProgressFileAdapter(), home, clock, { workspaceRoots: [root] });
  const snap = await engine.tick();
  const cursor = snap.sessions.find((x) => x.agentLabel === 'Cursor');
  const copilot = snap.sessions.find((x) => x.agentLabel === 'Copilot');
  assert.equal(cursor?.status, 'working');
  assert.equal(cursor?.title, 'Dark mode');
  assert.equal(cursor?.projectPath, root);
  assert.equal(cursor?.activity?.label, 'Components');
  assert.equal(copilot?.status, 'waiting');
  assert.equal(copilot?.statusDetail, 'Which palette?');
  assert.equal(snap.sessions[0].agentLabel, 'Copilot', 'waiting sorts first');

  clock.advance(2 * 3_600_000);
  const later = await engine.tick();
  assert.equal(later.sessions.find((x) => x.agentLabel === 'Cursor')?.status, 'stale');
});

test('addProgressProtocol appends once', async () => {
  const root = tmpHome();
  writeText(path.join(root, 'AGENTS.md'), '# Rules\nUse pnpm.');
  assert.equal((await addProgressProtocol(root)).result, 'added');
  assert.equal((await addProgressProtocol(root)).result, 'exists');
  const text = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.startsWith('# Rules\nUse pnpm.\n\n'));
  assert.equal(text.split(PROGRESS_PROTOCOL_MARKER).length, 2);
});

test('Claude hook installer preserves user settings and is idempotent', async () => {
  const home = tmpHome();
  const file = path.join(home, '.claude', 'settings.json');
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  writeText(file, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [userHook], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));

  assert.equal(await claudeHooksStatus(file), 'not-installed');
  const { backup } = await installClaudeHooks(file, 47821);
  assert.ok(backup);
  await installClaudeHooks(file, 47821);
  assert.equal(await claudeHooksStatus(file, 47821), 'installed');
  assert.equal(await claudeHooksStatus(file, 50000), 'outdated');

  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.PreToolUse, [userHook]);
  assert.equal(s.hooks.Stop.length, 2, "user's Stop hook kept, Kvali's added once");
  assert.equal(s.hooks.Notification[0].hooks[0].command, claudeHookCommand(47821));
  assert.equal(s.hooks.Notification[0].hooks[0].async, true);

  assert.equal((await uninstallClaudeHooks(file)).changed, true);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.hooks, { PreToolUse: [userHook], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });

  writeText(file, '{ broken');
  await assert.rejects(installClaudeHooks(file), /not valid JSON/);
});

test('Hook hub stores sanitized live state and rejects unsafe input', async () => {
  const home = tmpHome();
  const liveDir = path.join(home, 'live');
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const hub = new HookHub({ port, liveDir });
  hub.start();
  for (let i = 0; i < 50 && !hub.isHub; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(hub.isHub);

  const post = (body: unknown, type = 'application/json') =>
    fetch(`http://127.0.0.1:${port}/v1/events/claude-code`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });

  const ok = await post({ session_id: 'abc-123', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', prompt: 'secret' });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '');
  for (let i = 0; i < 50; i += 1) {
    try {
      readFileSync(path.join(liveDir, 'claude-code', 'abc-123.json'));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const live = JSON.parse(readFileSync(path.join(liveDir, 'claude-code', 'abc-123.json'), 'utf8'));
  assert.equal(live.notificationType, 'permission_prompt');
  assert.equal(live.prompt, undefined, 'prompts are never stored');

  assert.equal((await post({ session_id: 'x' }, 'text/plain')).status, 404);
  assert.equal(normalizeHookPayload('claude-code', { session_id: '../../etc/passwd' }), undefined);
  hub.dispose();
});

test('Engine isolates a failing adapter', async () => {
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const broken = { id: 'broken', label: 'Broken', poll: async () => Promise.reject(new Error('boom')) };
  const engine = engineFor(broken, tmpHome(), clock);
  const snap = await engine.tick();
  assert.deepEqual(snap.errors, [{ agent: 'broken', message: 'boom' }]);
  // and a healthy adapter still works next to it
  const root = tmpHome();
  writeText(path.join(root, '.agents', 'progress.md'), '# T\n- [ ] a\n');
  const e2 = engineFor(new ProgressFileAdapter(), root, new Clock(new Date().toISOString()), { workspaceRoots: [root] });
  assert.equal((await only(e2)).title, 'T');
});
