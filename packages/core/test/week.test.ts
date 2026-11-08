import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { weekSnapshot } from '../src/engine.ts';
import type { AgentSession } from '../src/model.ts';
import { fmtWork, weekDays, weekRange, weekShareText, weekStats, weekSvg } from '../src/week.ts';
import { Clock, tmpHome, writeJsonl } from './helpers.ts';

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('weekStats: seven days of work, tasks, tokens and agents, without project names', () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const days = weekDays(now);
  assert.equal(days.length, 7);
  assert.equal(days[6], '2026-11-06');
  assert.equal(days[0], '2026-10-31');
  const session = (over: Partial<AgentSession>): AgentSession => ({
    key: Math.random().toString(),
    agent: 'claude-code',
    agentLabel: 'Claude Code',
    id: 'x',
    title: 'Secret client project',
    projectPath: '/work/client-a',
    status: 'idle',
    startedAt: now,
    updatedAt: now,
    tasks: [],
    sources: [],
    ...over,
  });
  const w = weekStats(
    [
      session({ costUsd: 12, daily: { '2026-11-06': { tokens: 2_000_000, costUsd: 10, activeMs: 3 * 3_600_000, tasksDone: 9 }, '2026-11-02': { tokens: 500_000, costUsd: 2, activeMs: 3_600_000, tasksDone: 3 } } }),
      session({ agent: 'codex', agentLabel: 'Codex', projectPath: '/work/api', daily: { '2026-11-05': { tokens: 300_000, costUsd: 0, activeMs: 30 * 60_000, tasksDone: 2 } } }),
      // Last week: not counted.
      session({ agent: 'gemini-cli', agentLabel: 'Gemini CLI', daily: { '2026-10-20': { tokens: 9, costUsd: 0, activeMs: 9, tasksDone: 9 } } }),
      // Keeps no per-day usage, worked this week.
      session({ agent: 'antigravity', agentLabel: 'Antigravity', projectPath: '/work/client-a' }),
    ],
    now,
  );
  assert.equal(w.activeMs, 4.5 * 3_600_000);
  assert.equal(w.tasksDone, 14);
  assert.equal(w.tokens, 2_800_000);
  assert.equal(w.costUsd, 12);
  assert.equal(w.priced, true);
  assert.equal(w.sessions, 3);
  assert.equal(w.projects, 2);
  assert.deepEqual(w.agents, ['Claude Code', 'Codex', 'Antigravity']);
  assert.equal(w.busiest?.day, '2026-11-06');
  assert.equal(fmtWork(w.activeMs), '4.5 h');
  assert.equal(fmtWork(31.4 * 3_600_000), '31 h');
  assert.equal(fmtWork(45 * 60_000), '45 min');
  assert.equal(weekRange(w), 'Oct 31 – Nov 6');
  const text = weekShareText(w);
  assert.equal(
    text,
    'My AI coding agents this week with Claude Code, Codex and Antigravity: 4.5 h of agent work, 14 tasks done, 2.80M tokens.\n\nTracked with Kvali, an open-source progress bar for AI agents: https://github.com/webGrandpa/kvali',
  );
  assert.match(weekShareText(w, { cost: true }), /\$12\.00 at API prices/);
  const svg = weekSvg(w);
  assert.match(svg, /^<svg /);
  assert.match(svg, /4\.5 h/);
  assert.doesNotMatch(svg + text, /client|Secret|\/work/, 'no project names or titles');
});

test('weekSnapshot reads every session of the last seven days, work time and finished steps included', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-11-06T09:00:00.000Z');
  const SID = 'aaaaaaaa-1111-4a2b-9c3d-5e6f7a8b9c0d';
  const base = (offset: number) => ({ sessionId: SID, cwd: '/work/shop', timestamp: clock.iso(offset) });
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = (offset: number, id: string, content: unknown[], stop = 'tool_use') => ({
    ...base(offset),
    type: 'assistant',
    requestId: `r_${id}`,
    message: { id: `m_${id}`, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: stop, usage },
  });
  const result = (offset: number, id: string) => ({ ...base(offset), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [
    { ...base(0), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Add the checkout' } },
    reply(60_000, 'a', [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Form', status: 'in_progress', activeForm: 'Building the form' }, { content: 'Tests', status: 'pending' }] } }]),
    result(61_000, 't1'),
    reply(5 * 60_000, 'b', [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Form', status: 'completed' }, { content: 'Tests', status: 'in_progress' }] } }]),
    result(5 * 60_000 + 1_000, 't2'),
    // A long pause: the person was away, that is not work.
    { ...base(3 * 3_600_000), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'go on' } },
    reply(3 * 3_600_000 + 120_000, 'c', [{ type: 'text', text: 'Done.' }], 'end_turn'),
  ]);
  clock.advance(4 * 3_600_000);
  const snap = await weekSnapshot({ home, env: {}, now: clock.now, adapters: [new ClaudeCodeAdapter()] });
  const s = snap.sessions[0]!;
  const today = s.daily?.[day(clock.t)];
  assert.equal(today?.tasksDone, 1);
  // 60 s to the first reply, 1 s, 239 s, 1 s, then 120 s after the person's "go on".
  assert.equal(today?.activeMs, 60_000 + 1_000 + 239_000 + 1_000 + 120_000);
});
