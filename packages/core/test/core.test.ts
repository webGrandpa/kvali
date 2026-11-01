import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProgressFileAdapter } from '../src/adapters/progress-file.ts';
import { fmtTokens, fmtUsd, groupByProject, pathWithin, redactPaths } from '../src/format.ts';
import { claudeHookCommand, claudeHooksStatus, installClaudeHooks, uninstallClaudeHooks } from '../src/hooks/claude-install.ts';
import { HookHub, normalizeHookPayload } from '../src/hooks/hub.ts';
import { CLAUDE_PLAN_CONTEXT, claudeHookReply } from '../src/hooks/replies.ts';
import type { AgentSession } from '../src/model.ts';
import { progressOf } from '../src/model.ts';
import { Pricing, anthropicModelKey } from '../src/pricing.ts';
import { addGlobalPlanRule, addProgressProtocol, PLAN_RULE_MARKER, PROGRESS_PROTOCOL_MARKER, removeGlobalPlanRule } from '../src/protocol.ts';
import { parseChecklist } from '../src/util/checklist.ts';
import { JsonlTail } from '../src/util/jsonl.ts';
import { TaskTimer } from '../src/util/task-timer.ts';
import { mergeProgressFiles } from '../src/engine.ts';
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

test('addProgressProtocol updates an older Kvali section in place', async () => {
  const root = tmpHome();
  const file = path.join(root, 'AGENTS.md');
  const old = '<!-- kvali:progress-protocol v1 -->\n## Progress reporting\n\n- Otherwise, maintain `.agents/progress.md`.\n<!-- /kvali:progress-protocol -->';
  writeText(file, `# Rules\nUse pnpm.\n\n${old}\n\n## After\nKeep this.\n`);
  assert.equal((await addProgressProtocol(root)).result, 'updated');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# Rules\nUse pnpm.\n\n<!-- kvali:progress-protocol v2 -->'));
  assert.ok(text.endsWith('<!-- /kvali:progress-protocol -->\n\n## After\nKeep this.\n'), 'text after the section is kept');
  assert.ok(!text.includes('v1 -->') && text.includes('do not create `.agents/progress.md`'));
  assert.equal((await addProgressProtocol(root)).result, 'exists');

  // Windows line endings stay Windows line endings, and a current section is not rewritten again.
  const crlf = path.join(tmpHome(), 'x');
  writeText(path.join(crlf, 'AGENTS.md'), `# Rules\r\n\r\n${old.replace(/\n/g, '\r\n')}\r\n`);
  assert.equal((await addProgressProtocol(crlf)).result, 'updated');
  const t2 = readFileSync(path.join(crlf, 'AGENTS.md'), 'utf8');
  assert.ok(!/[^\r]\n/.test(t2), 'no bare LF');
  assert.equal((await addProgressProtocol(crlf)).result, 'exists');

  // Without the closing marker Kvali cannot tell where its section ends, so it changes nothing.
  const open = path.join(tmpHome(), 'y');
  const broken = `# Rules\n\n<!-- kvali:progress-protocol v1 -->\n## Progress reporting\nmy own notes\n`;
  writeText(path.join(open, 'AGENTS.md'), broken);
  assert.equal((await addProgressProtocol(open)).result, 'exists');
  assert.equal(readFileSync(path.join(open, 'AGENTS.md'), 'utf8'), broken);
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
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].async, undefined, 'the prompt hook is synchronous so it can return planning context');
  assert.ok(!s.hooks.UserPromptSubmit[0].hooks[0].command.includes('/dev/null'));

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

test('Hook hub refuses requests addressed to a host name other than this computer', async () => {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const hub = new HookHub({ port, liveDir: path.join(tmpHome(), 'live') });
  hub.start();
  for (let i = 0; i < 50 && !hub.isHub; i += 1) await new Promise((r) => setTimeout(r, 20));
  const status = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/health', headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  assert.equal(await status(`127.0.0.1:${port}`), 200);
  assert.equal(await status(`localhost:${port}`), 200);
  // a web page that pointed its own name at 127.0.0.1 (DNS rebinding)
  assert.equal(await status(`attacker.example:${port}`), 403);
  assert.equal(await status(`127.0.0.1:${port + 1}`), 403);
  hub.dispose();
});

test('redactPaths keeps file paths out of bug reports', () => {
  assert.equal(
    redactPaths("EACCES: permission denied, open '/Users/ana/.claude/projects/-Users-ana-shop/a1.jsonl'"),
    "EACCES: permission denied, open '<path>'",
  );
  assert.equal(redactPaths('cannot read C:\\Users\\ana\\.codex\\sessions\\x.jsonl: busy'), 'cannot read <path>: busy');
  assert.equal(redactPaths('watching ~/.kvali/live failed'), 'watching <path> failed');
  assert.equal(redactPaths('Unexpected token } in JSON at position 5'), 'Unexpected token } in JSON at position 5');
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

test('addGlobalPlanRule writes only to installed agents and only once', async () => {
  const home = tmpHome();
  writeText(path.join(home, '.claude', 'CLAUDE.md'), '# My rules\nAnswer in Georgian.\n');
  writeText(path.join(home, '.gemini', 'settings.json'), '{}');
  const first = await addGlobalPlanRule(home, {});
  assert.deepEqual(
    first.map((r) => [r.agent, r.result]),
    [
      ['Claude Code', 'added'],
      ['Gemini CLI / Antigravity', 'created'],
    ],
  );
  const claude = readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# My rules\nAnswer in Georgian.\n\n'));
  assert.ok(claude.includes(PLAN_RULE_MARKER));
  const second = await addGlobalPlanRule(home, {});
  assert.ok(second.every((r) => r.result === 'exists'));
});

test('addGlobalPlanRule refreshes an older rule in place and removal still finds it', async () => {
  const home = tmpHome();
  const file = path.join(home, '.gemini', 'GEMINI.md');
  const mine = '# Mine\nShort answers.\n';
  writeText(file, `${mine}\n<!-- kvali:plan-rule v0 -->\nOld wording.\n<!-- /kvali:plan-rule -->\n`);
  const [r] = await addGlobalPlanRule(home, {}, ['gemini']);
  assert.equal(r.result, 'updated');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith(`${mine}\n${PLAN_RULE_MARKER}`) && !text.includes('Old wording'));
  assert.equal((await addGlobalPlanRule(home, {}, ['gemini']))[0].result, 'exists');
  await removeGlobalPlanRule(home, {});
  assert.equal(readFileSync(file, 'utf8'), mine);
});

test('Hook status flags the older all-async layout as outdated', async () => {
  const home = tmpHome();
  const file = path.join(home, '.claude', 'settings.json');
  const old = (cmd: string) => [{ hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] }];
  const cmd = claudeHookCommand(47821);
  writeText(file, JSON.stringify({ hooks: { UserPromptSubmit: old(cmd), Notification: old(cmd), Stop: old(cmd), SessionEnd: old(cmd) } }));
  assert.equal(await claudeHooksStatus(file, 47821), 'outdated');
  await installClaudeHooks(file, 47821);
  assert.equal(await claudeHooksStatus(file, 47821), 'installed');
});

test('Planning context is sent only while a session has no unfinished plan', () => {
  const ev = { sessionId: 's', event: 'UserPromptSubmit', at: 0 };
  const base: AgentSession = { key: 'claude-code:s', agent: 'claude-code', agentLabel: 'Claude Code', id: 's', title: 't', status: 'idle', startedAt: 0, updatedAt: 0, tasks: [], sources: [] };
  const reply = claudeHookReply(ev, undefined) as any;
  assert.equal(reply.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(reply.hookSpecificOutput.additionalContext, CLAUDE_PLAN_CONTEXT);
  const running = { ...base, tasks: [{ id: '1', title: 'a', status: 'completed' as const }, { id: '2', title: 'b', status: 'in_progress' as const }] };
  assert.equal(claudeHookReply(ev, running), undefined);
  const finished = { ...base, tasks: [{ id: '1', title: 'a', status: 'completed' as const }] };
  assert.ok(claudeHookReply(ev, finished), 'a finished plan gets a nudge for the next request');
  assert.equal(claudeHookReply({ ...ev, event: 'Stop' }, undefined), undefined);
});

test('Hook hub returns the reply body to synchronous hooks', async () => {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const hub = new HookHub({ port, liveDir: path.join(tmpHome(), 'live'), respond: (_a, ev) => claudeHookReply(ev, undefined) });
  hub.start();
  for (let i = 0; i < 50 && !hub.isHub; i += 1) await new Promise((r) => setTimeout(r, 20));
  const res = await fetch(`http://127.0.0.1:${port}/v1/events/claude-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: 'abc', hook_event_name: 'UserPromptSubmit', prompt: 'do things' }),
  });
  const body = (await res.json()) as any;
  assert.equal(body.hookSpecificOutput.additionalContext, CLAUDE_PLAN_CONTEXT);
  hub.dispose();
});

test('removeGlobalPlanRule restores files and deletes the ones Kvali created', async () => {
  const home = tmpHome();
  const original = '# My rules\nAnswer in Georgian.\n';
  writeText(path.join(home, '.claude', 'CLAUDE.md'), original);
  writeText(path.join(home, '.gemini', 'settings.json'), '{}');
  await addGlobalPlanRule(home, {});
  const changed = await removeGlobalPlanRule(home, {});
  assert.equal(changed.length, 2);
  assert.equal(readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), original);
  assert.throws(() => readFileSync(path.join(home, '.gemini', 'GEMINI.md')));
  const only = await addGlobalPlanRule(home, {}, ['gemini']);
  assert.deepEqual(only.map((r) => r.agent), ['Gemini CLI / Antigravity']);
});

test('TaskTimer times the current step and learns the typical step duration', () => {
  const timer = new TaskTimer();
  const plan = (a: string, b: string, c: string) => [
    { id: '1', title: 'Design', status: a as any },
    { id: '2', title: 'Build', status: b as any },
    { id: '3', title: 'Test', status: c as any },
  ];
  timer.observe(plan('in_progress', 'pending', 'pending'), 0);
  timer.step();
  timer.observe(plan('completed', 'in_progress', 'pending'), 240_000);
  timer.step();
  timer.step();
  const cur = timer.current(plan('completed', 'in_progress', 'pending'));
  assert.deepEqual(cur, { taskId: '2', startedAt: 240_000, steps: 2, typicalMs: 240_000 });
  timer.observe(plan('completed', 'completed', 'in_progress'), 600_000);
  assert.equal(timer.current(plan('completed', 'completed', 'in_progress'))?.typicalMs, 300_000, 'median of 4m and 6m');
});

test('A progress file written by a natively tracked agent merges into that agent\'s card', () => {
  const base = { id: 'x', startedAt: 0, sources: [] as string[] };
  const claude: AgentSession = { ...base, key: 'claude-code:x', agent: 'claude-code', agentLabel: 'Claude Code', title: 'Site changes', projectPath: '/w/site', status: 'working', updatedAt: 10, tasks: [], sources: ['/t.jsonl'] };
  const pf: AgentSession = {
    ...base,
    key: 'progress-file:/w/site/.agents/progress.md',
    agent: 'progress-file',
    agentLabel: 'Claude Code',
    title: 'Site changes',
    projectPath: '/w/site',
    status: 'working',
    updatedAt: 5,
    tasks: [{ id: '1', title: 'Phone check', status: 'in_progress' }],
    sources: ['/w/site/.agents/progress.md'],
  };
  const other: AgentSession = { ...pf, key: 'progress-file:/w/other', agentLabel: 'Cursor', projectPath: '/w/other' };
  const merged = mergeProgressFiles([claude, pf, other]);
  assert.deepEqual(merged.map((s) => s.key), ['claude-code:x', 'progress-file:/w/other']);
  assert.equal(merged[0].tasks[0].title, 'Phone check', 'the native card borrows the plan it lacked');
});
