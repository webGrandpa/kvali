import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterContext } from './adapter.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { GeminiCliAdapter } from './adapters/gemini-cli.ts';
import { ProgressFileAdapter } from './adapters/progress-file.ts';
import type { AgentId, AgentSession, Snapshot } from './model.ts';
import { STATUS_PRIORITY } from './model.ts';
import { Pricing } from './pricing.ts';

export interface EngineOptions {
  adapters?: Adapter[];
  /** Agent ids to skip. */
  disabled?: readonly AgentId[];
  intervalMs?: number;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  activeWindowMs?: number;
  staleAfterMs?: number;
  maxSessionsPerAgent?: number;
  workspaceRoots?: readonly string[];
  pricing?: Pricing;
  liveDir?: string;
  extraAntigravityBrainDirs?: readonly string[];
  log?: (message: string) => void;
}

export function defaultLiveDir(home = os.homedir()): string {
  return path.join(home, '.kvali', 'live');
}

export function createDefaultAdapters(opts: Pick<EngineOptions, 'extraAntigravityBrainDirs'> = {}): Adapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new GeminiCliAdapter(),
    new AntigravityAdapter(opts.extraAntigravityBrainDirs),
    new ProgressFileAdapter(),
  ];
}

export function sortSessions(sessions: AgentSession[]): AgentSession[] {
  return sessions.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt - a.updatedAt);
}

/**
 * Polls every adapter on an interval and publishes a merged, sorted snapshot.
 * One adapter failing never affects the others: its error is reported in `snapshot.errors`.
 */
export class Engine {
  private adapters: Adapter[];
  private readonly ctx: AdapterContext;
  private readonly listeners = new Set<(s: Snapshot) => void>();
  private intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = true;
  private lastSignature = '';
  private current: Snapshot = { generatedAt: 0, sessions: [], errors: [] };
  private disabled: Set<AgentId>;

  constructor(opts: EngineOptions = {}) {
    const home = opts.home ?? os.homedir();
    this.adapters = opts.adapters ?? createDefaultAdapters(opts);
    this.disabled = new Set(opts.disabled ?? []);
    this.intervalMs = opts.intervalMs ?? 1_500;
    this.ctx = {
      home,
      env: opts.env ?? process.env,
      now: opts.now ?? Date.now,
      activeWindowMs: opts.activeWindowMs ?? 24 * 3_600_000,
      staleAfterMs: opts.staleAfterMs ?? 30 * 60_000,
      maxSessionsPerAgent: opts.maxSessionsPerAgent ?? 40,
      workspaceRoots: opts.workspaceRoots ?? [],
      pricing: opts.pricing ?? new Pricing(),
      liveDir: opts.liveDir ?? defaultLiveDir(home),
      log: opts.log ?? (() => {}),
    };
  }

  get snapshot(): Snapshot {
    return this.current;
  }

  /** Applies new settings; takes effect on the next tick. */
  configure(opts: Pick<EngineOptions, 'workspaceRoots' | 'pricing' | 'activeWindowMs' | 'staleAfterMs' | 'disabled' | 'intervalMs'>): void {
    if (opts.workspaceRoots) this.ctx.workspaceRoots = opts.workspaceRoots;
    if (opts.pricing) this.ctx.pricing = opts.pricing;
    if (opts.activeWindowMs) this.ctx.activeWindowMs = opts.activeWindowMs;
    if (opts.staleAfterMs) this.ctx.staleAfterMs = opts.staleAfterMs;
    if (opts.disabled) this.disabled = new Set(opts.disabled);
    if (opts.intervalMs) this.intervalMs = opts.intervalMs;
    this.lastSignature = '';
  }

  /** Swaps adapters, e.g. after a setting that changes an adapter's constructor options. */
  setAdapters(adapters: Adapter[]): void {
    for (const a of this.adapters) a.dispose?.();
    this.adapters = adapters;
    this.lastSignature = '';
  }

  onSnapshot(listener: (s: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    for (const a of this.adapters) a.dispose?.();
    this.listeners.clear();
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.tick();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.intervalMs);
  }

  /** Runs one poll of every adapter. Safe to call directly (e.g. a "Refresh" command). */
  async tick(): Promise<Snapshot> {
    if (this.running) return this.current;
    this.running = true;
    try {
      const sessions: AgentSession[] = [];
      const errors: Snapshot['errors'] = [];
      for (const a of this.adapters) {
        if (this.disabled.has(a.id)) continue;
        try {
          sessions.push(...(await a.poll(this.ctx)));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ agent: a.id, message });
          this.ctx.log(`[${a.id}] ${message}`);
        }
      }
      sortSessions(sessions);
      const signature = JSON.stringify([sessions, errors]);
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.current = { generatedAt: this.ctx.now(), sessions, errors };
        for (const l of this.listeners) {
          try {
            l(this.current);
          } catch (err) {
            this.ctx.log(`listener failed: ${String(err)}`);
          }
        }
      }
      return this.current;
    } finally {
      this.running = false;
    }
  }
}
