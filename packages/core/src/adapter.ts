import type { AgentLimits } from './limits.ts';
import type { AgentId, AgentSession } from './model.ts';
import type { Pricing } from './pricing.ts';
import { JsonlTail } from './util/jsonl.ts';

export interface AdapterContext {
  home: string;
  env: Record<string, string | undefined>;
  now(): number;
  /** Sessions whose files were not modified within this window are ignored. */
  activeWindowMs: number;
  /** A `working` session with no new activity for this long becomes `stale`. */
  staleAfterMs: number;
  /** Upper bound of sessions each adapter tracks (newest first). */
  maxSessionsPerAgent: number;
  /** Open workspace folders, used by project-local adapters such as progress files. */
  workspaceRoots: readonly string[];
  pricing: Pricing;
  /** Directory where the hook hub stores live per-session state (`~/.kvali/live`). */
  liveDir: string;
  log(message: string): void;
}

/**
 * An adapter turns one agent's local files into normalized sessions.
 *
 * `poll` is called every ~1.5 s. It must be cheap: discover files at a slower
 * cadence, keep per-file state, and read only what was appended since the last call.
 * See docs/ADAPTERS.md for a walkthrough.
 */
export interface Adapter {
  readonly id: AgentId;
  readonly label: string;
  poll(ctx: AdapterContext): Promise<AgentSession[]>;
  /** The account's plan limits as of the last poll, for agents that report them. */
  limits?(ctx: AdapterContext): AgentLimits | undefined;
  dispose?(): void;
}

export interface Candidate {
  path: string;
  mtimeMs: number;
}

interface Tracked<S> {
  tail: JsonlTail;
  state: S;
}

/**
 * Base class for agents that append to one JSONL file per session.
 * Subclasses describe where files live and how to fold records into state.
 */
export abstract class JsonlSessionAdapter<S> implements Adapter {
  abstract readonly id: AgentId;
  abstract readonly label: string;

  protected discoveryIntervalMs = 5_000;
  private readonly tracked = new Map<string, Tracked<S>>();
  private lastDiscovery = 0;

  protected abstract discover(ctx: AdapterContext): Promise<Candidate[]>;
  protected abstract createState(path: string): S;
  protected abstract onRecord(state: S, record: unknown, ctx: AdapterContext): void;
  protected abstract toSession(state: S, ctx: AdapterContext): AgentSession | undefined;
  /** Optional hook to read side files (plans, live state) after the transcript was read. */
  protected async afterRead(_state: S, _ctx: AdapterContext, _changed: boolean): Promise<void> {}

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (this.tracked.size === 0 || now - this.lastDiscovery >= this.discoveryIntervalMs) {
      this.lastDiscovery = now;
      const candidates = (await this.discover(ctx))
        .filter((c) => now - c.mtimeMs <= ctx.activeWindowMs)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, ctx.maxSessionsPerAgent);
      const keep = new Set(candidates.map((c) => c.path));
      for (const c of candidates) {
        if (!this.tracked.has(c.path)) {
          this.tracked.set(c.path, { tail: new JsonlTail(c.path), state: this.createState(c.path) });
        }
      }
      for (const p of [...this.tracked.keys()]) if (!keep.has(p)) this.tracked.delete(p);
    }

    const sessions: AgentSession[] = [];
    for (const [p, t] of this.tracked) {
      const res = await t.tail.read(
        (record) => this.onRecord(t.state, record, ctx),
        () => {
          t.state = this.createState(p);
        },
      );
      await this.afterRead(t.state, ctx, res.changed);
      const s = this.toSession(t.state, ctx);
      if (s) sessions.push(s);
    }
    return sessions;
  }
}

/** Shared status helper: turns `working` into `stale` after a long silence. */
export function staleness(updatedAt: number, ctx: AdapterContext): string | undefined {
  const idleMs = ctx.now() - updatedAt;
  if (idleMs < ctx.staleAfterMs) return undefined;
  const mins = Math.round(idleMs / 60_000);
  return mins >= 120 ? `No activity for ${Math.round(mins / 60)}h` : `No activity for ${mins}m`;
}
