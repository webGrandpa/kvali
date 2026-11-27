import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSession } from '../src/model.ts';
import { KeepAwake, agentsWorking, holdCommand, keepAwakeMode, linuxMains, parsePmset, parseWinBattery, type Hold, type HoldCommand } from '../src/wake.ts';

/** A fake clock, timers and holds, so the tests run in no time. */
function rig(opts: { mains?: boolean | undefined; platform?: NodeJS.Platform } = {}) {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const started: HoldCommand[] = [];
  const holds: { stopped: boolean; end: (missing: boolean) => void }[] = [];
  const logs: string[] = [];
  const state = { mains: 'mains' in opts ? opts.mains : true, powerReads: 0 };
  const awake = new KeepAwake({
    platform: opts.platform ?? 'darwin',
    pid: 4242,
    log: (m) => logs.push(m),
    now: () => now,
    power: async () => {
      state.powerReads += 1;
      return state.mains;
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    start: (c): Hold => {
      started.push(c);
      let onEnd: (missing: boolean) => void = () => {};
      const h = { stopped: false, end: (missing: boolean) => onEnd(missing) };
      holds.push(h);
      return {
        stop: () => {
          h.stopped = true;
        },
        onEnd: (fn) => {
          onEnd = fn;
        },
      };
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { awake, started, holds, logs, state, advance };
}

test('Keeps the computer awake while an agent works, and lets it sleep a minute after the last one stops', async () => {
  const r = rig();
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.awake.active, true);
  assert.deepEqual(r.started, [{ cmd: 'caffeinate', args: ['-i', '-w', '4242'] }]);

  // The turn ends; another starts within the minute: the same hold carries on.
  await r.awake.update(false, 'whenPluggedIn');
  r.advance(30_000);
  assert.equal(r.awake.active, true, 'still held during the grace minute');
  await r.awake.update(true, 'whenPluggedIn');
  r.advance(60_000);
  assert.equal(r.started.length, 1, 'no second hold');
  assert.equal(r.awake.active, true);

  // Nothing works any more: a minute later the hold is let go.
  await r.awake.update(false, 'whenPluggedIn');
  r.advance(59_000);
  assert.equal(r.awake.active, true);
  r.advance(1_000);
  assert.equal(r.awake.active, false);
  assert.equal(r.holds[0]!.stopped, true);
  assert.ok(r.logs.some((l) => /may sleep again/.test(l)));
});

test('Off means off, battery power waits for the charger, and "always" holds on battery too', async () => {
  const r = rig({ mains: false });
  await r.awake.update(true, 'off');
  assert.equal(r.awake.active, false);
  assert.equal(r.state.powerReads, 0, 'no power reading when off');

  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.awake.active, false, 'on battery: no hold');

  await r.awake.update(true, 'always');
  assert.equal(r.awake.active, true, '"always" holds on battery');

  await r.awake.update(true, 'off');
  assert.equal(r.awake.active, false, 'turning it off lets go at once');
  assert.equal(r.holds[0]!.stopped, true);

  // Plugged in: the next reading (after the cached one expires) allows the hold again.
  r.state.mains = true;
  r.advance(61_000);
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.awake.active, true);

  // Unplugged while working: let go.
  r.state.mains = false;
  r.advance(61_000);
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.awake.active, false);
});

test('Power that cannot be read counts as plugged in', async () => {
  const r = rig({ mains: undefined });
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.awake.active, true);
});

test('A missing or refusing command is reported once, not retried every minute', async () => {
  const r = rig();
  await r.awake.update(true, 'always');
  r.holds[0]!.end(true); // ENOENT: no caffeinate
  assert.equal(r.awake.active, false);
  r.advance(120_000);
  await r.awake.update(true, 'always');
  assert.equal(r.started.length, 1, 'not tried again');
  assert.equal(r.logs.filter((l) => /was not found/.test(l)).length, 1);

  // Changing the setting tries once more.
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.started.length, 2);
  r.holds[1]!.end(false); // exited right after it started (refused)
  r.advance(120_000);
  await r.awake.update(true, 'whenPluggedIn');
  assert.equal(r.started.length, 2, 'a hold refused at once is not retried');
});

test('A hold that ends by itself later is started again after a minute', async () => {
  const r = rig();
  await r.awake.update(true, 'always');
  r.advance(30 * 60_000);
  r.holds[0]!.end(false); // killed after half an hour
  assert.equal(r.awake.active, false);
  await r.awake.update(true, 'always');
  assert.equal(r.started.length, 1, 'waits before trying again');
  r.advance(61_000);
  await r.awake.update(true, 'always');
  assert.equal(r.started.length, 2);
  assert.equal(r.awake.active, true);
});

test('Change listeners hear when the hold starts and ends; dispose lets go', async () => {
  const r = rig();
  const seen: boolean[] = [];
  r.awake.onChange((a) => seen.push(a));
  await r.awake.update(true, 'always');
  r.awake.dispose();
  assert.deepEqual(seen, [true, false]);
  assert.equal(r.holds[0]!.stopped, true);
});

test('The hold command for each system follows Kvali’s process', () => {
  assert.deepEqual(holdCommand('darwin', 77), { cmd: 'caffeinate', args: ['-i', '-w', '77'] });
  const linux = holdCommand('linux', 77)!;
  assert.equal(linux.cmd, 'systemd-inhibit');
  assert.ok(linux.args.includes('--what=idle'));
  assert.match(linux.args.at(-1)!, /kill -0 77/);
  const win = holdCommand('win32', 77)!;
  assert.equal(win.cmd, 'powershell.exe');
  assert.match(win.args.at(-1)!, /SetThreadExecutionState\(\[uint32\]2147483649\)/);
  assert.match(win.args.at(-1)!, /Get-Process -Id 77/);
  assert.equal(holdCommand('aix', 77), undefined);
  assert.equal(holdCommand('darwin', 0), undefined);
  assert.equal(holdCommand('darwin', Number.NaN), undefined);
});

test('Power readings on macOS, Windows and Linux', () => {
  assert.equal(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged"), true);
  assert.equal(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging"), false);
  assert.equal(parsePmset(''), undefined);
  assert.equal(parseWinBattery(''), true, 'no battery: a desktop');
  assert.equal(parseWinBattery('2\r\n'), true, 'on AC');
  assert.equal(parseWinBattery('1'), false, 'discharging');
  assert.equal(parseWinBattery('x'), undefined);
  assert.equal(linuxMains([]), true, 'no supplies: a desktop');
  assert.equal(linuxMains([{ type: 'Mains', online: '1' }, { type: 'Battery' }]), true);
  assert.equal(linuxMains([{ type: 'Mains', online: '0' }, { type: 'Battery' }]), false);
  assert.equal(linuxMains([{ type: 'USB_PD', online: '1' }, { type: 'Battery' }]), true);
});

test('Only agents at work count: not one that waits for you, nor one gone quiet with nothing running', () => {
  const now = 10_000_000;
  const s = (x: Partial<AgentSession>) => ({ status: 'working', updatedAt: now, ...x }) as AgentSession;
  assert.equal(agentsWorking([s({})], now), true);
  assert.equal(agentsWorking([s({ status: 'waiting' })], now), false);
  assert.equal(agentsWorking([s({ status: 'done' })], now), false);
  assert.equal(agentsWorking([s({ updatedAt: now - 11 * 60_000 })], now), false, 'quiet for 11 minutes');
  assert.equal(
    agentsWorking([s({ updatedAt: now - 40 * 60_000, activity: { kind: 'command', label: 'Running pnpm test', startedAt: now - 40 * 60_000 } })], now),
    true,
    'a long command still runs',
  );
  assert.equal(agentsWorking([s({ updatedAt: now - 11 * 60_000, pulse: { phase: 'running', since: now - 60_000, at: now - 5_000 } })], now), true, 'the plugin’s heartbeat is recent');
  assert.equal(agentsWorking([], now), false);
  assert.equal(keepAwakeMode('always'), 'always');
  assert.equal(keepAwakeMode('sometimes'), 'whenPluggedIn');
  assert.equal(keepAwakeMode(undefined, 'off'), 'off');
});
