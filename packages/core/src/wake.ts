/**
 * Keeps the computer from going to sleep while an agent works, for every agent Kvali sees, and
 * lets it sleep again a minute after the last one stops.
 *
 * The hold is a small child process that ends by itself when Kvali does (it follows Kvali's
 * process id):
 *
 *   macOS    caffeinate -i -w <pid>                              (idle sleep only; the display may still sleep)
 *   Linux    systemd-inhibit --what=idle … sh -c 'while kill -0 <pid> …'
 *   Windows  PowerShell calling SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) while <pid> runs
 *
 * Closing a laptop's lid still puts it to sleep: only idle sleep is held off.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentSession } from './model.ts';

export type KeepAwakeMode = 'off' | 'whenPluggedIn' | 'always';
export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['off', 'whenPluggedIn', 'always'];

/** How long the computer stays awake after the last agent stops: a next turn often follows within seconds. */
export const KEEP_AWAKE_GRACE_MS = 60_000;
/** A working session that has shown nothing this long, with nothing running, may be stuck: it doesn't keep the computer up. */
export const KEEP_AWAKE_QUIET_MS = 10 * 60_000;
/** How long a power reading (mains or battery) is trusted. */
const POWER_TTL_MS = 60_000;
/** After a hold ends by itself (killed, crashed), how long before trying again. */
const RETRY_MS = 60_000;
/** A hold that ends this soon after it started was refused, not stopped. */
const QUICK_END_MS = 5_000;

export function keepAwakeMode(v: unknown, fallback: KeepAwakeMode = 'whenPluggedIn'): KeepAwakeMode {
  return KEEP_AWAKE_MODES.includes(v as KeepAwakeMode) ? (v as KeepAwakeMode) : fallback;
}

/** Whether any agent is at work: working, and either running something or heard from in the last minutes. */
export function agentsWorking(sessions: readonly AgentSession[], now: number): boolean {
  return sessions.some((s) => {
    if (s.status !== 'working') return false;
    const running = !!s.activity && s.activity.endedAt === undefined && s.activity.kind !== 'thinking' && s.activity.kind !== 'message';
    const last = Math.max(s.updatedAt, s.pulse?.at ?? 0);
    return running || now - last < KEEP_AWAKE_QUIET_MS;
  });
}

export interface HoldCommand {
  cmd: string;
  args: string[];
}

/** The command that keeps this computer awake until it is stopped or process `pid` exits; undefined where Kvali has none. */
export function holdCommand(platform: NodeJS.Platform, pid: number): HoldCommand | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  switch (platform) {
    case 'darwin':
      return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
    case 'linux':
      return {
        cmd: 'systemd-inhibit',
        args: ['--what=idle', '--who=Kvali', '--why=An AI agent is working', '--mode=block', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`],
      };
    case 'win32':
      return {
        cmd: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            `$k = Add-Type -Name Awake -Namespace Kvali -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
            // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, written in decimal: PowerShell 5 reads 0x80000001 as a negative Int32.
            '[void]$k::SetThreadExecutionState([uint32]2147483649)',
            `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
          ].join('; '),
        ],
      };
    default:
      return undefined;
  }
}

/** `pmset -g ps`: "Now drawing from 'AC Power'" or "'Battery Power'". */
export function parsePmset(out: string): boolean | undefined {
  if (/'AC Power'/.test(out)) return true;
  if (/'Battery Power'/.test(out)) return false;
  return undefined;
}

/** Win32_Battery.BatteryStatus: empty without a battery (a desktop), 1, 4 and 5 while it discharges. */
export function parseWinBattery(out: string): boolean | undefined {
  const v = out.trim();
  if (!v) return true;
  const n = Number(v.split(/\s+/)[0]);
  if (!Number.isInteger(n)) return undefined;
  return ![1, 4, 5].includes(n);
}

/** /sys/class/power_supply: plugged in when a mains or USB supply is online; no supplies at all is a desktop. */
export function linuxMains(supplies: readonly { type: string; online?: string }[]): boolean | undefined {
  if (!supplies.length) return true;
  const external = supplies.filter((s) => s.type === 'Mains' || s.type.startsWith('USB'));
  if (external.some((s) => s.online === '1')) return true;
  if (supplies.some((s) => s.type === 'Battery')) return false;
  return undefined;
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 5_000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout)));
    } catch {
      resolve(undefined);
    }
  });
}

/** Whether the computer runs on mains power; undefined when that can't be told. */
export async function onMainsPower(platform: NodeJS.Platform = process.platform): Promise<boolean | undefined> {
  if (platform === 'darwin') {
    const out = await run('pmset', ['-g', 'ps']);
    return out === undefined ? undefined : parsePmset(out);
  }
  if (platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1).BatteryStatus']);
    return out === undefined ? undefined : parseWinBattery(out);
  }
  if (platform === 'linux') {
    const base = '/sys/class/power_supply';
    try {
      const names = await fsp.readdir(base);
      const read = async (name: string, file: string) => (await fsp.readFile(path.join(base, name, file), 'utf8').catch(() => undefined))?.trim();
      const supplies = await Promise.all(names.map(async (n) => ({ type: (await read(n, 'type')) ?? '', online: await read(n, 'online') })));
      return linuxMains(supplies);
    } catch {
      return true;
    }
  }
  return undefined;
}

/** A running hold: stop it, and hear when it ends by itself. */
export interface Hold {
  stop(): void;
  onEnd(fn: (missing: boolean) => void): void;
}

function spawnHold(c: HoldCommand): Hold {
  const child = spawn(c.cmd, c.args, { stdio: 'ignore', windowsHide: true });
  child.unref();
  let ended: ((missing: boolean) => void) | undefined;
  let done = false;
  const end = (missing: boolean) => {
    if (done) return;
    done = true;
    ended?.(missing);
  };
  child.on('error', (err: NodeJS.ErrnoException) => end(err.code === 'ENOENT'));
  child.on('exit', () => end(false));
  return {
    stop: () => {
      done = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
    onEnd: (fn) => {
      ended = fn;
    },
  };
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  /** The process the hold follows: it ends by itself when this one exits. */
  pid?: number;
  graceMs?: number;
  log?: (message: string) => void;
  /** Hooks for tests. */
  start?: (c: HoldCommand) => Hold;
  power?: () => Promise<boolean | undefined>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Holds the computer awake while `update` says an agent works (and the mode allows it), and
 * lets go a minute after the last one stops. Call `update` with every snapshot, and now and then
 * without one: the grace period ends on its own timer.
 */
export class KeepAwake {
  private hold?: Hold;
  private releaseTimer?: unknown;
  private mode: KeepAwakeMode = 'off';
  private working = false;
  private missing = false;
  private retryAt = 0;
  private powerReading?: { at: number; mains: boolean | undefined };
  private readonly listeners = new Set<(active: boolean) => void>();
  private readonly platform: NodeJS.Platform;
  private readonly pid: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly o: KeepAwakeOptions;

  constructor(o: KeepAwakeOptions = {}) {
    this.o = o;
    this.platform = o.platform ?? process.platform;
    this.pid = o.pid ?? process.pid;
    this.graceMs = o.graceMs ?? KEEP_AWAKE_GRACE_MS;
    this.now = o.now ?? Date.now;
  }

  /** True while the computer is being kept awake. */
  get active(): boolean {
    return !!this.hold;
  }

  /** Called when `active` changes. */
  onChange(fn: (active: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async update(working: boolean, mode: KeepAwakeMode): Promise<void> {
    if (mode !== this.mode) this.missing = false;
    this.mode = mode;
    this.working = working;
    if (mode === 'off') return this.release('turned off');
    if (!working) {
      if (this.hold && this.releaseTimer === undefined) {
        const t = (this.o.setTimer ?? setTimeout)(() => {
          this.releaseTimer = undefined;
          if (!this.working) this.release('no agent is working');
        }, this.graceMs);
        // The timer alone never keeps Kvali's process running.
        (t as { unref?: () => void } | undefined)?.unref?.();
        this.releaseTimer = t;
      }
      return;
    }
    this.clearRelease();
    if (mode === 'whenPluggedIn' && (await this.mains()) === false) return this.release('on battery');
    // The setting or the agents may have changed while the power was read.
    if (!this.working || this.mode === 'off' || (this.mode === 'whenPluggedIn' && this.powerReading?.mains === false)) return;
    this.acquire();
  }

  dispose(): void {
    this.release();
    this.listeners.clear();
  }

  private async mains(): Promise<boolean | undefined> {
    const now = this.now();
    if (this.powerReading && now - this.powerReading.at < POWER_TTL_MS) return this.powerReading.mains;
    const mains = await (this.o.power ?? (() => onMainsPower(this.platform)))().catch(() => undefined);
    this.powerReading = { at: this.now(), mains };
    return mains;
  }

  private acquire(): void {
    if (this.hold || this.missing || this.now() < this.retryAt) return;
    const c = holdCommand(this.platform, this.pid);
    if (!c) {
      this.missing = true;
      this.o.log?.(`Keeping the computer awake isn't supported on ${this.platform}.`);
      return;
    }
    let hold: Hold;
    try {
      hold = (this.o.start ?? spawnHold)(c);
    } catch (err) {
      this.missing = true;
      this.o.log?.(`Could not keep the computer awake: ${(err as Error).message}`);
      return;
    }
    this.hold = hold;
    const startedAt = this.now();
    hold.onEnd((missing) => {
      if (this.hold !== hold) return;
      this.hold = undefined;
      if (missing) {
        this.missing = true;
        this.o.log?.(`Could not keep the computer awake: ${c.cmd} was not found.`);
      } else if (this.now() - startedAt < QUICK_END_MS) {
        // Refused at once (no permission, no session bus): trying every minute would only repeat that.
        this.missing = true;
        this.o.log?.(`Could not keep the computer awake: ${c.cmd} stopped right after it started.`);
      } else {
        this.retryAt = this.now() + RETRY_MS;
        this.o.log?.(`The hold that kept the computer awake (${c.cmd}) ended by itself.`);
      }
      this.emit();
    });
    this.o.log?.('Keeping the computer awake while an agent works.');
    this.emit();
  }

  private release(why?: string): void {
    this.clearRelease();
    if (!this.hold) return;
    const hold = this.hold;
    this.hold = undefined;
    hold.stop();
    if (why) this.o.log?.(`The computer may sleep again (${why}).`);
    this.emit();
  }

  private clearRelease(): void {
    if (this.releaseTimer === undefined) return;
    (this.o.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout)))(this.releaseTimer);
    this.releaseTimer = undefined;
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.active);
  }
}
