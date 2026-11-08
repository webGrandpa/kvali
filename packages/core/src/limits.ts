/**
 * Plan limits: how much of a subscription's usage window is used, and whether the recent
 * pace uses it up before it resets.
 *
 * A subscription allows so much use per window (Claude: five hours and seven days; Codex:
 * its primary and secondary windows). The agents report how much of each window is used;
 * Kvali keeps the readings over time, from every session that reports them, so it can tell
 * when a window runs out at the pace of the last hour. Pure, so the webview can use it too.
 */
import type { AgentId, RateLimitWindow } from './model.ts';

export interface LimitReading {
  /** Human label, e.g. "5h" or "Weekly". */
  label: string;
  /** 0–100. */
  usedPercent: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** An agent's limits, account-wide: the latest reading of each window. */
export interface AgentLimits {
  agent: AgentId;
  agentLabel: string;
  windows: RateLimitWindow[];
}

/** Readings older than this are dropped. */
const KEEP_MS = 6 * 3_600_000;
/** The forecast follows the pace of this much recent time. */
export const PACE_MS = 60 * 60_000;
/** Less than this between the first and the latest reading says nothing about a pace. */
const MIN_SPAN_MS = 5 * 60_000;
/** A reset time that moves more than this starts a new window. */
const RESET_JITTER_MS = 5 * 60_000;
/** An unchanged percentage is recorded again at most this often. */
const SAMPLE_EVERY_MS = 5 * 60_000;

interface Sample {
  at: number;
  pct: number;
}

interface WindowBook {
  latest: LimitReading & { at: number };
  samples: Sample[];
}

/**
 * When a window is used up at the pace of its recent readings, if that comes before it
 * resets: `undefined` when the pace is unknown (too few or too old readings), flat, or slow
 * enough to last. A window already used up ran out at its latest reading.
 */
export function runsOutAt(samples: readonly Sample[], latest: { at: number; usedPercent: number; resetsAt?: number }, now: number): number | undefined {
  if (latest.usedPercent >= 100) return latest.at;
  if (now - latest.at > PACE_MS) return undefined;
  const recent = samples.filter((s) => s.at >= latest.at - PACE_MS && s.at <= latest.at);
  const first = recent[0];
  if (!first || latest.at - first.at < MIN_SPAN_MS) return undefined;
  const rate = (latest.usedPercent - first.pct) / (latest.at - first.at);
  if (!(rate > 0)) return undefined;
  const out = latest.at + (100 - latest.usedPercent) / rate;
  if (latest.resetsAt !== undefined && out >= latest.resetsAt) return undefined;
  return Math.round(out);
}

/** The readings of each window over time, from every session that reports them. */
export class LimitBook {
  private readonly books = new Map<string, WindowBook>();

  /** Adds a reading taken at `at`. Older readings than the window's latest are ignored. */
  add(reading: LimitReading, at: number): void {
    if (!Number.isFinite(reading.usedPercent) || !Number.isFinite(at)) return;
    const pct = Math.max(0, reading.usedPercent);
    let book = this.books.get(reading.label);
    if (book) {
      const sameWindow =
        book.latest.resetsAt === undefined || reading.resetsAt === undefined || Math.abs(book.latest.resetsAt - reading.resetsAt) <= RESET_JITTER_MS;
      if (!sameWindow) {
        // A reading of an earlier window says nothing now; a later one starts a new window.
        if (at <= book.latest.at) return;
        book = undefined;
      } else if (at < book.latest.at) {
        // An older reading (another session's file, read late) still tells the pace.
        if (at >= book.latest.at - KEEP_MS && !book.samples.some((s) => s.at === at)) {
          book.samples.push({ at, pct });
          book.samples.sort((a, b) => a.at - b.at);
        }
        return;
      }
    }
    if (!book) {
      book = { latest: { ...reading, usedPercent: pct, at }, samples: [] };
      this.books.set(reading.label, book);
    }
    const last = book.samples[book.samples.length - 1];
    if (!last || last.pct !== pct || at - last.at >= SAMPLE_EVERY_MS) book.samples.push({ at, pct });
    book.latest = { ...reading, usedPercent: pct, at };
    const cutoff = at - KEEP_MS;
    while (book.samples.length > 1 && book.samples[0]!.at < cutoff) book.samples.shift();
  }

  get size(): number {
    return this.books.size;
  }

  /** The latest reading of each window, with when it runs out at the recent pace. Windows that have reset are dropped. */
  windows(now: number): RateLimitWindow[] {
    const out: RateLimitWindow[] = [];
    for (const [label, b] of this.books) {
      const l = b.latest;
      if (l.resetsAt !== undefined && l.resetsAt <= now) {
        this.books.delete(label);
        continue;
      }
      out.push({
        label: l.label,
        usedPercent: l.usedPercent,
        resetsAt: l.resetsAt,
        windowMinutes: l.windowMinutes,
        at: l.at,
        runsOutAt: runsOutAt(b.samples, l, now),
      });
    }
    return out.sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  }
}

/** Claude Code's window kinds (`five_hour`, `seven_day`, `seven_day_opus`, a gateway's `spend_limit`) as labels. */
export function claudeWindowLabel(kind: string): { label: string; windowMinutes?: number } {
  if (kind === 'five_hour') return { label: '5h', windowMinutes: 300 };
  const week = /^seven_day(?:_(\w+))?$/.exec(kind);
  if (week) return { label: week[1] ? `Weekly ${week[1][0]!.toUpperCase()}${week[1].slice(1)}` : 'Weekly', windowMinutes: 10_080 };
  if (kind === 'spend_limit') return { label: 'Spend' };
  return { label: kind.replace(/_/g, ' ') };
}

/** The window that matters most now: one that runs out before it resets, else the fullest. */
export function pressingWindow(limits: readonly AgentLimits[] | undefined): { limits: AgentLimits; window: RateLimitWindow } | undefined {
  const all = (limits ?? []).flatMap((l) => l.windows.map((window) => ({ limits: l, window })));
  const runningOut = all.filter((x) => x.window.runsOutAt !== undefined).sort((a, b) => a.window.runsOutAt! - b.window.runsOutAt!);
  return runningOut[0] ?? all.sort((a, b) => b.window.usedPercent - a.window.usedPercent)[0];
}
