/**
 * Notices an agent going in circles: the same action failing again and again with the same
 * error, whatever it does in between (it edits a file, runs the same failing test, edits
 * again). Each adapter feeds it the outcome of every tool call; a failure with a new error
 * is progress, the same error four times in a row is not.
 */

/** The same error this many times in a row is a loop. */
export const SAME_ERROR_RUNS = 4;
/** So are this many failures in a row, whatever their errors. */
export const ANY_ERROR_RUNS = 8;
/** A failure longer ago than this starts over. */
const FORGET_MS = 30 * 60_000;

export interface Loop {
  /** What keeps failing, e.g. "Run the tests". */
  label: string;
  /** The command or file, e.g. "pnpm test". */
  detail?: string;
  /** Failures in a row. */
  count: number;
  /** The same error every time (else the errors differ, and there are many). */
  sameError: boolean;
  /** When the first of them happened. */
  since: number;
  /** The session's tokens when it began, to tell what the loop cost. */
  tokensAtStart?: number;
}

interface Streak {
  label: string;
  detail?: string;
  count: number;
  same: number;
  sig: string;
  since: number;
  last: number;
  tokens?: number;
}

/** A short fingerprint of an error's last lines; numbers (times, counts, ports) do not count. */
export function errorSignature(text: string): string {
  const tail = text
    .slice(-600)
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < tail.length; i++) {
    h ^= tail.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class LoopWatch {
  private readonly streaks = new Map<string, Streak>();

  /**
   * One finished call. `key` names the action ("command:pnpm test", "Edit:src/a.ts"); `error`
   * is the failure's text, or undefined when the call worked, which ends that action's streak.
   */
  observe(key: string, what: { label: string; detail?: string }, error: string | undefined, at: number, tokens?: number): void {
    if (error === undefined) {
      this.streaks.delete(key);
      return;
    }
    const sig = errorSignature(error);
    const s = this.streaks.get(key);
    if (!s || at - s.last > FORGET_MS) {
      this.streaks.set(key, { label: what.label, detail: what.detail, count: 1, same: 1, sig, since: at, last: at, tokens });
      return;
    }
    s.count += 1;
    s.same = s.sig === sig ? s.same + 1 : 1;
    s.sig = sig;
    s.last = at;
    s.label = what.label;
  }

  /** The person spoke (or stopped the agent): whatever it was stuck on is theirs to judge now. */
  reset(): void {
    this.streaks.clear();
  }

  /** The longest streak that counts as a loop, if any. */
  current(now: number): Loop | undefined {
    let best: Streak | undefined;
    for (const s of this.streaks.values()) {
      if (now - s.last > FORGET_MS) continue;
      if (s.same < SAME_ERROR_RUNS && s.count < ANY_ERROR_RUNS) continue;
      if (!best || s.count > best.count) best = s;
    }
    return best
      ? { label: best.label, detail: best.detail, count: best.count, sameError: best.same >= SAME_ERROR_RUNS, since: best.since, tokensAtStart: best.tokens }
      : undefined;
  }
}

/** The key of an action for the watch: a command by its command line, a file tool by its file. */
export function loopKey(a: { kind: string; label: string; detail?: string }): string {
  return a.kind === 'command' ? `command:${a.detail ?? a.label}` : `${a.label}:${a.detail ?? ''}`;
}
