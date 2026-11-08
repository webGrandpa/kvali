import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { LimitBook, claudeWindowLabel, pressingWindow, runsOutAt } from '../src/limits.ts';
import { PushPlanner, limitPush, normalizePhoneConfig, type PhoneEvent } from '../src/phone.ts';
import type { Snapshot } from '../src/model.ts';
import { Clock, engineFor, tmpHome, writeJsonl, writeText } from './helpers.ts';

const MIN = 60_000;

test('LimitBook: the pace of the last hour says when a window runs out, if before it resets', () => {
  const t0 = 1_000_000_000_000;
  const resetsAt = t0 + 3 * 60 * MIN;
  const book = new LimitBook();
  // 40% → 70% in half an hour: 1% a minute, so 100% in 30 more minutes, long before the reset.
  book.add({ label: '5h', usedPercent: 40, resetsAt, windowMinutes: 300 }, t0);
  book.add({ label: '5h', usedPercent: 55, resetsAt, windowMinutes: 300 }, t0 + 15 * MIN);
  book.add({ label: '5h', usedPercent: 70, resetsAt, windowMinutes: 300 }, t0 + 30 * MIN);
  book.add({ label: 'Weekly', usedPercent: 20, resetsAt: t0 + 5 * 1_440 * MIN, windowMinutes: 10_080 }, t0 + 30 * MIN);
  const [five, week] = book.windows(t0 + 31 * MIN);
  assert.equal(five!.label, '5h', 'the shorter window first');
  assert.equal(five!.usedPercent, 70);
  assert.equal(five!.runsOutAt, t0 + 60 * MIN);
  assert.equal(week!.runsOutAt, undefined, 'one reading: no pace yet');

  // A slow pace lasts until the reset: no warning.
  const slow = new LimitBook();
  slow.add({ label: '5h', usedPercent: 10, resetsAt }, t0);
  slow.add({ label: '5h', usedPercent: 12, resetsAt }, t0 + 30 * MIN);
  assert.equal(slow.windows(t0 + 31 * MIN)[0]!.runsOutAt, undefined);

  // A reading of the next window starts over; one of an earlier window, read late, is ignored.
  book.add({ label: '5h', usedPercent: 2, resetsAt: resetsAt + 5 * 60 * MIN }, t0 + 4 * 60 * MIN);
  book.add({ label: '5h', usedPercent: 90, resetsAt }, t0 + 40 * MIN);
  const next = book.windows(t0 + 4 * 60 * MIN + MIN).find((w) => w.label === '5h')!;
  assert.deepEqual([next.usedPercent, next.runsOutAt], [2, undefined]);

  // A reading older than the latest (another session's heartbeat, read late) still counts for the pace.
  const late = new LimitBook();
  late.add({ label: '5h', usedPercent: 70, resetsAt }, t0 + 30 * MIN);
  late.add({ label: '5h', usedPercent: 40, resetsAt }, t0);
  assert.equal(late.windows(t0 + 31 * MIN)[0]!.runsOutAt, t0 + 60 * MIN);

  // A window that has reset is gone; one used up ran out at its reading.
  assert.equal(new LimitBook().windows(t0).length, 0);
  const gone = new LimitBook();
  gone.add({ label: '5h', usedPercent: 50, resetsAt: t0 + MIN }, t0);
  assert.equal(gone.windows(t0 + 2 * MIN).length, 0);
  assert.equal(runsOutAt([], { at: t0, usedPercent: 100 }, t0 + MIN), t0);
  // Readings an hour old say nothing about the pace now.
  assert.equal(book.windows(t0 + 6 * 60 * MIN).find((w) => w.label === 'Weekly')?.runsOutAt, undefined);
});

test('claudeWindowLabel and pressingWindow', () => {
  assert.deepEqual(claudeWindowLabel('five_hour'), { label: '5h', windowMinutes: 300 });
  assert.deepEqual(claudeWindowLabel('seven_day'), { label: 'Weekly', windowMinutes: 10_080 });
  assert.deepEqual(claudeWindowLabel('seven_day_opus'), { label: 'Weekly Opus', windowMinutes: 10_080 });
  assert.equal(claudeWindowLabel('spend_limit').label, 'Spend');
  const limits = [
    { agent: 'codex', agentLabel: 'Codex', windows: [{ label: '5h', usedPercent: 85 }] },
    { agent: 'claude-code', agentLabel: 'Claude Code', windows: [{ label: '5h', usedPercent: 60, runsOutAt: 5 }, { label: 'Weekly', usedPercent: 30 }] },
  ];
  assert.equal(pressingWindow(limits)?.window.runsOutAt, 5, 'one that runs out comes first');
  assert.equal(pressingWindow([limits[0]!])?.window.usedPercent, 85);
  assert.equal(pressingWindow(undefined), undefined);
});

test('Codex: every session\'s readings feed one account-wide forecast', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const d = new Date(clock.t);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const resetsAt = Math.round(clock.t / 1000) + 4 * 3_600;
  const reading = (id: string, offset: number, pct: number) => ({
    timestamp: clock.iso(offset),
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: resetsAt } } },
  });
  const meta = (id: string) => ({ timestamp: clock.iso(0), type: 'session_meta', payload: { id, cwd: '/work/api', cli_version: '0.98.0' } });
  writeJsonl(path.join(dir, 'rollout-2026-10-30T10-00-00-aaaa.jsonl'), [meta('aaaa'), reading('aaaa', 0, 30)]);
  writeJsonl(path.join(dir, 'rollout-2026-10-30T10-20-00-bbbb.jsonl'), [meta('bbbb'), reading('bbbb', 20 * MIN, 50)]);
  clock.advance(21 * MIN);
  const engine = engineFor(new CodexAdapter(), home, clock);
  const snap = await engine.tick();
  const five = snap.limits?.find((l) => l.agent === 'codex')?.windows[0];
  assert.equal(five?.label, '5h');
  assert.equal(five?.usedPercent, 50);
  // 1% a minute from 50% at 10:20: used up at 11:10, before the reset at 14:00.
  assert.equal(five?.runsOutAt, clock.t - MIN + 50 * MIN);
});

test('Claude Code: the plugin\'s heartbeat carries the usage windows and their recent readings', async () => {
  const home = tmpHome();
  const clock = new Clock('2026-10-30T10:00:00.000Z');
  const SID = '0b7c4f9e-1111-4a2b-9c3d-5e6f7a8b9c0d';
  const file = path.join(home, '.claude', 'projects', '-work-shop', `${SID}.jsonl`);
  writeJsonl(file, [{ sessionId: SID, cwd: '/work/shop', timestamp: clock.iso(0), type: 'user', message: { role: 'user', content: 'Refactor the checkout' } }]);
  const resetsAt = new Date(clock.t + 3 * 3_600_000).toISOString();
  const at = clock.t + 30 * MIN;
  writeText(
    path.join(home, '.kvali', 'live', 'claude-code', `${SID}.mod.json`),
    JSON.stringify({
      v: 1,
      agent: 'claude-code',
      sessionId: SID,
      at,
      phase: 'done',
      since: at,
      limits: {
        at,
        windows: [
          { kind: 'five_hour', percentUsed: 82, resetsAt },
          { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(clock.t + 4 * 86_400_000).toISOString() },
        ],
        samples: { five_hour: [[clock.t, 52], [clock.t + 15 * MIN, 67], [at, 82]], seven_day: [[at, 41]] },
      },
    }),
  );
  clock.advance(31 * MIN);
  const snap = await engineFor(new ClaudeCodeAdapter(), home, clock).tick();
  const claude = snap.limits?.find((l) => l.agent === 'claude-code');
  assert.equal(claude?.agentLabel, 'Claude Code');
  assert.deepEqual(
    claude?.windows.map((w) => [w.label, w.usedPercent, w.runsOutAt]),
    [
      ['5h', 82, at + 18 * MIN],
      ['Weekly', 41, undefined],
    ],
  );
});

test('phone: one push when a usage window will run out within the hour, none for one already low at start', () => {
  let now = 1_000_000_000_000;
  const planner = new PushPlanner({ now: () => now });
  const cfg = { events: ['limits'] as PhoneEvent[], details: true };
  const snap = (windows: Snapshot['limits']): Snapshot => ({ generatedAt: now, sessions: [], errors: [], limits: windows });
  const claude = (w: object) => [{ agent: 'claude-code', agentLabel: 'Claude Code', windows: [{ label: '5h', usedPercent: 60, resetsAt: now + 3 * 3_600_000, ...w }] }];
  assert.deepEqual(planner.observe(snap(claude({})), cfg), []);
  now += 5 * MIN;
  const pushes = planner.observe(snap(claude({ usedPercent: 70, runsOutAt: now + 35 * MIN })), cfg);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.event, 'limits');
  assert.equal(pushes[0]!.title, 'Claude Code: 5h limit runs out in ~35m');
  assert.match(pushes[0]!.message, /^70% used\. At the pace of the last hour it is used up around .+; it resets at .+\.$/);
  assert.equal(pushes[0]!.priority, 4);
  now += MIN;
  assert.deepEqual(planner.observe(snap(claude({ usedPercent: 92, runsOutAt: now + 20 * MIN })), cfg), [], 'one push per window');
  // Already at 90% when Kvali started: not news.
  const fresh = new PushPlanner({ now: () => now });
  assert.deepEqual(fresh.observe(snap(claude({ usedPercent: 93 })), cfg), []);
  assert.deepEqual(fresh.observe(snap(claude({ usedPercent: 94 })), cfg), []);
  // Not chosen: nothing.
  const off = new PushPlanner({ now: () => now });
  off.observe(snap(claude({})), { events: ['done'], details: true });
  assert.deepEqual(off.observe(snap(claude({ usedPercent: 91 })), { events: ['done'], details: true }), []);
  assert.equal(limitPush({ agentLabel: 'Codex' }, { label: 'Weekly', usedPercent: 90.4 }, now).title, 'Codex: Weekly limit 90% used');
});

test('phone settings from 0.6 with the default choices get limit alerts too', () => {
  const v2 = normalizePhoneConfig({ v: 2, topic: 'kvali-abc', events: ['needs-you', 'done', 'error', 'stuck', 'steps'] });
  assert.ok(v2?.events.includes('limits'));
  const chosen = normalizePhoneConfig({ v: 2, topic: 'kvali-abc', events: ['needs-you', 'done'] });
  assert.deepEqual(chosen?.events, ['needs-you', 'done'], 'a choice of one\'s own stays');
  const v3 = normalizePhoneConfig({ v: 3, topic: 'kvali-abc', events: ['needs-you', 'done', 'error', 'stuck', 'steps'] });
  assert.ok(!v3?.events.includes('limits'), 'turned off after 0.7: stays off');
});
