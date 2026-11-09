/**
 * Hostile or broken input, and the files Kvali writes: what the November 2026 security audit
 * found, each kept fixed by a test.
 */
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { installClaudeHooks } from '../src/hooks/claude-install.ts';
import { LimitBook } from '../src/limits.ts';
import { globMatch, Pricing } from '../src/pricing.ts';
import { addGlobalPlanRule, addProgressProtocol, findBlock, removeGlobalPlanRule, withoutBlock } from '../src/protocol.ts';
import { parseChecklist } from '../src/util/checklist.ts';
import { writeFileSafely } from '../src/util/files.ts';
import { JsonlTail, MAX_LINE_BYTES } from '../src/util/jsonl.ts';
import { cleanText, stripInjectedTags } from '../src/util/text.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { MAX_PROGRESS_FILES, ProgressFileAdapter } from '../src/adapters/progress-file.ts';
import { formatPush, pushAgentLabel } from '../src/phone.ts';
import { cleanSession, mergeProgressFiles } from '../src/engine.ts';
import { weekStats, weekSvg } from '../src/week.ts';
import type { AgentSession } from '../src/model.ts';
import { appendJsonl, Clock, engineFor, tmpHome, writeJsonl, writeText } from './helpers.ts';
import { appendFileSync } from 'node:fs';

/** Milliseconds `fn` takes. */
function timed(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

test('Turn off never removes text it cannot tell is Kvali\'s: no closing marker, no change', async () => {
  const home = tmpHome();
  const file = path.join(home, '.codex', 'AGENTS.md');
  const text = '# My rules\nUse pnpm.\n\n<!-- kvali:plan-rule v2 -->\n## Keep a visible plan\n\n## My other rules\nNever push to main.\n';
  writeText(file, text);
  assert.deepEqual(await removeGlobalPlanRule(home, {}), []);
  assert.equal(readFileSync(file, 'utf8'), text, 'every line of the file is still there');
});

test("Kvali's markers count only on lines of their own, outside code fences", async () => {
  const shown = '# Notes\n\nKvali adds a section like this:\n\n```md\n<!-- kvali:plan-rule v1 -->\nexample\n<!-- /kvali:plan-rule -->\n```\n\nMy rule.\n';
  assert.equal(findBlock(shown, 'plan-rule'), undefined, 'an example in a fence is not a block');
  assert.equal(findBlock('see <!-- kvali:plan-rule v2 --> here\n', 'plan-rule'), undefined, 'nor a marker inside a sentence');

  const home = tmpHome();
  const file = path.join(home, '.gemini', 'GEMINI.md');
  writeText(file, shown);
  await addGlobalPlanRule(home, {}, ['gemini']);
  const added = readFileSync(file, 'utf8');
  assert.ok(added.startsWith(shown), 'the example stays as it was, and the rule is added after it');
  await removeGlobalPlanRule(home, {});
  assert.equal(readFileSync(file, 'utf8'), shown);

  // The repository protocol: an example section in a fence does not make Kvali replace the text below it.
  const root = tmpHome();
  const agents = path.join(root, 'AGENTS.md');
  const doc = '# Rules\n\n~~~\n<!-- kvali:progress-protocol v1 -->\n~~~\nKeep these three lines.\nLine two.\n<!-- /kvali:progress-protocol -->\nLine three.\n';
  writeText(agents, doc);
  await addProgressProtocol(root);
  assert.ok(readFileSync(agents, 'utf8').startsWith(doc));
});

test('Removing a block keeps the rest of the file, Windows line endings included', () => {
  const crlf = '# Mine\r\nA rule.\r\n\r\n<!-- kvali:plan-rule v2 -->\r\nText.\r\n<!-- /kvali:plan-rule -->\r\n\r\n# After\r\nB rule.\r\n';
  assert.equal(withoutBlock(crlf, 'plan-rule'), '# Mine\r\nA rule.\r\n\r\n# After\r\nB rule.\r\n');
  assert.equal(withoutBlock('<!-- kvali:plan-rule v2 -->\nText.\n<!-- /kvali:plan-rule -->\n', 'plan-rule'), '');
  const many = `# Mine${'\n'.repeat(60_000)}<!-- kvali:plan-rule v2 -->\nx\n<!-- /kvali:plan-rule -->`;
  const t = performance.now();
  assert.equal(withoutBlock(many, 'plan-rule'), '# Mine\n');
  assert.ok(performance.now() - t < 500, 'no slow case on many blank lines');
});

test('Files are replaced whole, keep their permissions, and a symlinked one stays a link', async () => {
  const dir = tmpHome();
  const file = path.join(dir, 'config.json');
  await writeFileSafely(file, '{"a":1}\n', 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await writeFileSafely(file, '{"a":2}\n');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'an existing file keeps its permissions');
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}\n');

  // A dotfiles setup: ~/.claude/settings.json is a link into a repository.
  const real = path.join(dir, 'dotfiles', 'settings.json');
  writeText(real, '{ "model": "opus" }\n');
  const settings = path.join(dir, '.claude', 'settings.json');
  writeText(path.join(dir, '.claude', 'keep'), '');
  symlinkSync(real, settings);
  await installClaudeHooks(settings, 47821);
  assert.ok(lstatSync(settings).isSymbolicLink(), 'still a link');
  assert.match(readFileSync(real, 'utf8'), /v1\/events\/claude-code/, 'the hooks went into the file it points to');
  assert.equal(statSync(`${settings}.kvali-backup`).mode & 0o777, 0o600, 'the backup, which may hold API keys, is for its owner only');
});

test("A repository's progress file cannot slow Kvali down, whatever its lines look like", () => {
  const hostile = ['---', `status: ${' '.repeat(50_000)}x`, '---', ...Array.from({ length: 50 }, () => `# a${' '.repeat(20_000)}#x`), `- [ ] a${' '.repeat(100_000)}x`].join('\n');
  assert.ok(timed(() => parseChecklist(hostile)) < 300, 'long lines of spaces parse in a moment');
  const many = Array.from({ length: 5_000 }, (_, i) => `- [ ] step ${i}`).join('\n');
  assert.equal(parseChecklist(many).tasks.length, 500, 'a plan is at most 500 steps');

  const p = parseChecklist('---\nconstructor: x\n__proto__: y\nstatus: done\n---\n# Ship it ##\n## Learn C#\n- [x] first   \n1. [/] second');
  assert.equal(p.title, 'Ship it');
  assert.equal(p.tasks[0]!.group, 'Learn C#', "a heading's own # stays");
  assert.deepEqual(p.tasks.map((t) => [t.title, t.status]), [['first', 'completed'], ['second', 'in_progress']]);
  assert.equal(p.frontmatter.status, 'done');
  assert.equal(Object.getPrototypeOf(p.frontmatter), null, 'front matter keys never reach Object.prototype');
});

test('Price patterns and injected tags are read in linear time', () => {
  assert.ok(globMatch('claude-*', 'Claude-Sonnet-4-6') && globMatch('gpt-?.5', 'gpt-5.5') && !globMatch('gpt-5*', 'o3'));
  assert.ok(globMatch('*', '') && globMatch('a*b*c', 'axxbyyc') && !globMatch('a*b*c', 'axxbyy'));
  assert.ok(timed(() => globMatch('*a*a*a*a*a*a*a*z', 'a'.repeat(60))) < 50);
  assert.equal(stripInjectedTags('hi <system-reminder>x</system-reminder>there <command-name>/fix</command-name>'), 'hi there /fix');
  assert.ok(timed(() => stripInjectedTags('<system-reminder>'.repeat(40_000))) < 200, 'unclosed tags do not make it slow');
});

test('A transcript line that is huge, or a record its reader cannot take, never stops the rest', async () => {
  const file = path.join(tmpHome(), 'big.jsonl');
  appendJsonl(file, [{ n: 1 }]);
  appendFileSync(file, `{"blob":"${'x'.repeat(MAX_LINE_BYTES + 1_000)}"}\n`);
  appendJsonl(file, [{ n: 2 }, { bad: true }, { n: 3 }]);
  const tail = new JsonlTail(file);
  const seen: unknown[] = [];
  await tail.read((r) => {
    if ((r as { bad?: boolean }).bad) throw new TypeError('Cannot convert object to primitive value');
    seen.push((r as { n?: number }).n);
  });
  assert.deepEqual(seen, [1, 2, 3], 'the oversized line is skipped and the throwing record does not hide the next');
  appendJsonl(file, [{ n: 4 }]);
  const more: unknown[] = [];
  await tail.read((r) => more.push((r as { n?: number }).n));
  assert.deepEqual(more, [4], 'and reading goes on from there');

  // An overlong line still being written: skipped to its end, then reading resumes.
  const growing = path.join(tmpHome(), 'growing.jsonl');
  appendFileSync(growing, `{"a":"${'y'.repeat(MAX_LINE_BYTES + 10)}`);
  const t2 = new JsonlTail(growing);
  await t2.read(() => assert.fail('nothing complete yet'));
  appendFileSync(growing, `"}\n{"n":5}\n`);
  const after: unknown[] = [];
  await t2.read((r) => after.push((r as { n?: number }).n));
  assert.deepEqual(after, [5]);
});

test('Plan limit readings are kept within sense', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const book = new LimitBook();
  book.add({ label: '5h', usedPercent: 1e9, resetsAt: now + 3_600_000 }, now - 1_000, now);
  assert.equal(book.windows(now)[0]?.usedPercent, 100);
  const future = new LimitBook();
  future.add({ label: '5h', usedPercent: 50, resetsAt: now + 3_600_000 }, now + 86_400_000, now);
  assert.equal(future.windows(now).length, 0, 'a reading from tomorrow is ignored');
  const busy = new LimitBook();
  for (let i = 0; i < 5_000; i += 1) busy.add({ label: '5h', usedPercent: i % 100, resetsAt: now + 3_600_000 }, now - 5_000 + i, now);
  assert.ok(timed(() => busy.add({ label: '5h', usedPercent: 3, resetsAt: now + 3_600_000 }, now - 10_000, now)) < 20);
});

test("One record Kvali cannot read leaves out that record, not the agent's sessions", async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-09T10:00:00.000Z');
  const line = (sid: string, offset: number, content: unknown[]) => ({ sessionId: sid, cwd: '/work/shop', timestamp: clock.iso(offset), type: 'assistant', requestId: `r${offset}`, uuid: `u${sid}${offset}`, message: { id: `m${offset}`, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } });
  const good = '11111111-1111-4111-8111-111111111111';
  const odd = '22222222-2222-4222-8222-222222222222';
  writeJsonl(path.join(home, '.claude', 'projects', '-work-shop', `${good}.jsonl`), [line(good, 0, [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Build it' } }])]);
  writeJsonl(path.join(home, '.claude', 'projects', '-work-shop', `${odd}.jsonl`), [
    // A tool name and a task subject that are objects whose toString is not a function: String() throws on them.
    line(odd, 0, [{ type: 'tool_use', id: 't1', name: { toString: 1 }, input: {} }]),
    line(odd, 1, [{ type: 'tool_use', id: 't2', name: 'TaskCreate', input: { subject: { toString: 1 } } }]),
    line(odd, 2, [{ type: 'tool_use', id: 't3', name: 'TaskCreate', input: { subject: 'Still read' } }]),
    { sessionId: odd, cwd: '/work/shop', timestamp: clock.iso(3), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Task #1 created successfully: Still read' }] }, toolUseResult: { task: { id: '1', subject: 'Still read' } } },
  ]);
  clock.advance(5_000);
  const snap = await engineFor(new ClaudeCodeAdapter(), home, clock).tick();
  assert.deepEqual(snap.errors, []);
  const ids = snap.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, [good, odd], 'both sessions are shown');
  assert.ok(snap.sessions.find((s) => s.id === odd)!.tasks.some((t) => t.title === 'Still read'), 'records after the odd ones are read');
});

test("A repository's progress file: unknown statuses are no statuses, and only the agent it names gets its plan", async () => {
  const root = tmpHome();
  writeText(path.join(root, '.agents', 'progress.md'), '---\nagent: a\nstatus: constructor\n---\n# Look here\n- [/] Visit evil.example\n');
  const clock = new Clock('2026-11-09T10:00:00.000Z');
  const snap = await engineFor(new ProgressFileAdapter(), root, clock, { workspaceRoots: [root] }).tick();
  const pf = snap.sessions[0]!;
  assert.equal(pf.status, 'working', 'status from the steps, not from Object.prototype');
  const claude: AgentSession = { key: 'claude-code:x', agent: 'claude-code', agentLabel: 'Claude Code', id: 'x', title: 'Real work', status: 'working', startedAt: 0, updatedAt: 1, tasks: [], sources: [], projectPath: root };
  const merged = mergeProgressFiles([claude, { ...pf, projectPath: root }]);
  assert.equal(merged.length, 2, '"a" is not Claude Code: the file keeps a card of its own');
  assert.deepEqual(merged.find((s) => s.agent === 'claude-code')!.tasks, []);
  const named = mergeProgressFiles([{ ...claude, tasks: [] }, { ...pf, agentLabel: 'Claude', projectPath: root }]);
  assert.equal(named.length, 1, 'a file that names the agent joins its card');
});

// Built from char codes, so this file holds no invisible characters itself.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

test('Text from files cannot drive a terminal or read differently from what it is', async () => {
  assert.equal(cleanText(`Fix ${ESC}]52;c;ZXZpbA==${BEL}the build`), 'Fix the build', 'OSC 52 (write the clipboard) is removed');
  assert.equal(cleanText(`${ESC}[2J${ESC}[31mRed${ESC}[0m`), 'Red', 'clear-screen and colour sequences are removed');
  assert.equal(cleanText(`invoice${RLO}fdp.exe`), 'invoicefdp.exe', 'a bidi override is removed');
  assert.equal(cleanText(`a${ZWSP}b\rc`), 'abc', 'zero-width characters and carriage returns are removed');
  const plain = 'Ship the café 🚀 — მზადაა\tok\nnext';
  assert.equal(cleanText(plain), plain, 'ordinary text, tabs and new lines are kept');
  assert.equal(cleanText('x'.repeat(5_000), 100).length, 100, 'long text is cut');

  const root = tmpHome();
  writeText(
    path.join(root, '.agents', 'progress.md'),
    `---\nagent: Bot${ESC}]0;pwned${BEL}\n---\n# Plan ${ESC}[2Jtwo\n- [/] Step ${ESC}]52;c;ZXZpbA==${BEL}one\n- [ ] Pay ${RLO}gnp.exe\n`,
  );
  const snap = await engineFor(new ProgressFileAdapter(), root, new Clock('2026-11-09T10:00:00.000Z'), { workspaceRoots: [root] }).tick();
  const s = snap.sessions[0]!;
  assert.equal(s.agentLabel, 'Bot');
  assert.equal(s.title, 'Plan two');
  assert.deepEqual(s.tasks.map((t) => t.title), ['Step one', 'Pay gnp.exe']);
  assert.ok(!strings(snap).some((t) => CONTROL.test(t) || t.includes(RLO)), 'nothing Kvali shows holds a control character');

  const clean: AgentSession = { key: 'claude-code:x', agent: 'claude-code', agentLabel: 'Claude Code', id: 'x', title: 'Real work', status: 'working', startedAt: 0, updatedAt: 1, tasks: [{ id: '1', title: 'Step', status: 'pending' }], sources: [] };
  assert.equal(cleanSession(clean), clean, 'a session with nothing to clean is passed on as it is');
});

test("The week card's SVG is well-formed whatever an agent is called", () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const day = weekStats([], now).days.at(-1)!.day;
  const s: AgentSession = {
    key: 'progress-file:x',
    agent: 'progress-file',
    agentLabel: `<script>alert(1)</script> & "Bot" ${ESC}[2J`,
    id: 'x',
    title: 't',
    status: 'done',
    startedAt: now - 3_600_000,
    updatedAt: now,
    tasks: [],
    sources: [],
    daily: { [day]: { tokens: 10, costUsd: 0, activeMs: 3_600_000 } },
  };
  const svg = weekSvg(weekStats([s], now));
  assert.ok(!svg.includes('<script>'), 'markup in a name stays text');
  assert.ok(svg.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Bot&quot;'));
  assert.ok(!CONTROL.test(svg.replace(/\n/g, '')), 'no character XML forbids');
});

test("A repository's progress files: only its own, only so many, and its words stay off the phone", async () => {
  const root = tmpHome();
  const outside = tmpHome();
  writeText(path.join(outside, 'notes.md'), '# My private notes\n- [/] Call the bank\n');
  writeText(path.join(root, '.agents', 'progress', 'own.md'), '# Own plan\n- [/] Build\n');
  if (process.platform !== 'win32') {
    symlinkSync(path.join(outside, 'notes.md'), path.join(root, '.agents', 'progress.md'));
  }
  for (let i = 0; i < MAX_PROGRESS_FILES + 5; i += 1) {
    const f = path.join(root, '.agents', 'progress', `extra-${String(i).padStart(2, '0')}.md`);
    writeText(f, `# Extra ${i}\n- [ ] Step\n`);
    const t = new Date(Date.parse('2026-11-09T09:00:00.000Z') + i * 1_000);
    utimesSync(f, t, t);
  }
  const clock = new Clock('2026-11-09T10:00:00.000Z');
  const snap = await engineFor(new ProgressFileAdapter(), root, clock, { workspaceRoots: [root] }).tick();
  const titles = snap.sessions.map((s) => s.title);
  assert.ok(!titles.includes('My private notes'), 'a link to a file outside the workspace is not read');
  assert.equal(snap.sessions.length, MAX_PROGRESS_FILES, 'at most so many files per workspace');
  assert.ok(titles.includes('Own plan'), 'the most recently written are the ones read');
  assert.ok(!titles.includes('Extra 0'), 'the oldest are left out');

  const pf: AgentSession = {
    key: 'progress-file:x',
    agent: 'progress-file',
    agentLabel: 'Your Apple ID is locked, see evil.example',
    id: 'x',
    title: 'Plan',
    status: 'waiting',
    statusDetail: 'Open https://evil.example/login now',
    startedAt: 0,
    updatedAt: 1,
    tasks: [],
    sources: [],
  };
  const push = formatPush('needs-you', pf, true);
  assert.equal(push.title.startsWith('An agent needs you'), true, push.title);
  assert.ok(!`${push.title}\n${push.message}`.includes('evil.example'), 'neither the name nor the note leaves the computer');
  assert.equal(pushAgentLabel({ ...pf, agentLabel: 'Cursor' }), 'Cursor');
  assert.equal(pushAgentLabel({ ...pf, agentLabel: 'GitHub Copilot' }), 'GitHub Copilot');
  assert.equal(pushAgentLabel({ agent: 'claude-code', agentLabel: 'Claude Code' }), 'Claude Code');
});

test('A price with a typo in the settings is no price, not NaN costs', () => {
  const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const typo = new Pricing({ 'my-model*': { input: 2, output: '8' as unknown as number } });
  assert.equal(typo.cost('my-model-1', usage), undefined, 'an output price that is not a number: no custom price');
  const partial = new Pricing({ 'my-model*': { input: 2, output: 8, cacheRead: 'x' as unknown as number, longPrompt: 5 as never } });
  assert.equal(partial.cost('my-model-1', usage), 2, 'the numbers that are numbers count, the rest is left out');
  assert.equal(new Pricing(null as never).cost('my-model-1', usage), undefined);
});
