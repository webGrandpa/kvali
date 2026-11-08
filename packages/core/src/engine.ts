import os from 'node:os';
import path from 'node:path';
import type { Adapter, AdapterContext } from './adapter.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { ClineAdapter, RooCodeAdapter } from './adapters/cline.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { CopilotAdapter } from './adapters/copilot.ts';
import { GeminiCliAdapter } from './adapters/gemini-cli.ts';
import { KiloCodeAdapter, OpenCodeAdapter } from './adapters/opencode.ts';
import { ProgressFileAdapter } from './adapters/progress-file.ts';
import type { AgentLimits } from './limits.ts';
import type { AgentId, AgentSession, Snapshot } from './model.ts';
import { STATUS_PRIORITY } from './model.ts';
import { pathWithin } from './format.ts';
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
  /**
   * More editor `globalStorage` folders to look for Cline and Roo Code in, besides the usual
   * places: the extension passes its own editor's, which covers portable installs and remotes.
   */
  extraEditorStorageDirs?: readonly string[];
  log?: (message: string) => void;
}

export function defaultLiveDir(home = os.homedir()): string {
  return path.join(home, '.kvali', 'live');
}

export function createDefaultAdapters(opts: Pick<EngineOptions, 'extraAntigravityBrainDirs' | 'extraEditorStorageDirs'> = {}): Adapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new GeminiCliAdapter(),
    new AntigravityAdapter(opts.extraAntigravityBrainDirs),
    new CopilotAdapter(),
    new ClineAdapter({ extraStorageDirs: opts.extraEditorStorageDirs }),
    new RooCodeAdapter({ extraStorageDirs: opts.extraEditorStorageDirs }),
    new OpenCodeAdapter(),
    new KiloCodeAdapter(),
    new ProgressFileAdapter(),
  ];
}

const sameProject = (a?: string, b?: string) => !!a && !!b && (pathWithin(a, b) || pathWithin(b, a));

/**
 * An agent that Kvali reads natively sometimes also writes `.agents/progress.md`.
 * Show one card: the native session (live activity, tokens), borrowing the file's plan
 * only when the agent keeps no plan of its own.
 */
export function mergeProgressFiles(sessions: AgentSession[]): AgentSession[] {
  const native = sessions.filter((s) => s.agent !== 'progress-file');
  const out = [...native];
  for (const pf of sessions) {
    if (pf.agent !== 'progress-file') continue;
    const label = pf.agentLabel.toLowerCase();
    const match = native
      .filter((n) => {
        const name = n.agentLabel.toLowerCase();
        const short = name.split(' ')[0];
        return (label.includes(short) || name.includes(label)) && sameProject(n.projectPath, pf.projectPath);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!match) {
      out.push(pf);
      continue;
    }
    if (match.tasks.length === 0 && pf.tasks.length > 0) {
      match.tasks = pf.tasks;
      match.current ??= pf.current;
    }
    match.sources = [...match.sources, ...pf.sources];
  }
  return out;
}

export function sortSessions(sessions: AgentSession[]): AgentSession[] {
  return sessions.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt - a.updatedAt);
}

/**
 * Every session of the last seven days, read once: what the weekly card counts. Slower than a
 * live tick (it reads a week of transcripts), so it runs when asked.
 */
export async function weekSnapshot(opts: EngineOptions = {}): Promise<Snapshot> {
  const engine = new Engine({ ...opts, adapters: opts.adapters ?? createDefaultAdapters(opts), activeWindowMs: 8 * 86_400_000, maxSessionsPerAgent: 5_000 });
  try {
    return await engine.tick();
  } finally {
    engine.dispose();
  }
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
      const limits: AgentLimits[] = [];
      for (const a of this.adapters) {
        if (this.disabled.has(a.id)) continue;
        try {
          sessions.push(...(await a.poll(this.ctx)));
          const l = a.limits?.(this.ctx);
          if (l?.windows.length) limits.push(l);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ agent: a.id, message });
          this.ctx.log(`[${a.id}] ${message}`);
        }
      }
      const merged = mergeProgressFiles(sessions);
      sortSessions(merged);
      const signature = JSON.stringify([merged, errors, limits]);
      if (signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.current = { generatedAt: this.ctx.now(), sessions: merged, errors, ...(limits.length ? { limits } : {}) };
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
