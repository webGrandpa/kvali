/**
 * Formatting and grouping helpers shared by every frontend.
 * Pure functions with no Node imports, so the webview can bundle them too.
 */
import type { AgentSession, SessionStatus } from './model.ts';
import { progressOf, totalTokens } from './model.ts';

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–';
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function fmtUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 1_000) return `$${Math.round(n)}`;
  return `$${(n / 1_000).toFixed(1)}k`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * How long the rest of the plan should take at the plan's own pace: the typical time of its
 * finished steps for each step left, less the time already spent on the current one.
 * `undefined` until a step has finished to measure by, and when nothing is left.
 */
export function planEta(s: Pick<AgentSession, 'tasks' | 'current'>, now: number): number | undefined {
  const typical = s.current?.typicalMs;
  if (!typical || typical <= 0) return undefined;
  const p = progressOf(s.tasks);
  const left = p.total - p.done;
  if (p.total === 0 || left <= 0) return undefined;
  const spent = s.current ? Math.max(0, now - s.current.startedAt) : 0;
  return Math.max(0, typical - spent) + (left - 1) * typical;
}

/** A time of day in the computer's own locale and time zone: "17:40" or "5:40 PM". */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A forecast, to the minute: "~30m", "~1h 05m". */
export function fmtAbout(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `~${m}m` : `~${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "~20m left", "~1h 10m left", "under a minute left". */
export function fmtEta(ms: number): string {
  if (ms < 60_000) return 'under a minute left';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `~${m}m left`;
  const h = Math.floor(m / 60);
  return m % 60 ? `~${h}h ${m % 60}m left` : `~${h}h left`;
}

export function fmtAgo(at: number, now: number): string {
  const s = Math.round((now - at) / 1_000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  stale: 'Stale',
};

function norm(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

/** True when `child` equals `parent` or is inside it. String-based, so it works in browsers too. */
export function pathWithin(child: string | undefined, parent: string): boolean {
  if (!child) return false;
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '/');
}

export function projectName(p: string | undefined): string {
  if (!p) return 'Other';
  const parts = norm(p).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Replaces file paths in a message (an error's text, say) with `<path>`, so a bug report
 * names no user, folder or project. Paths of two or more parts: `/Users/ana/.codex/x.jsonl`,
 * `C:\Users\ana\x`, `~/.kvali/live`.
 */
export function redactPaths(text: string): string {
  return text.replace(/(?:[A-Za-z]:|~)?(?:[\\/][^\s\\/'"`<>|:]+){2,}[\\/]?/g, '<path>');
}

export interface ProjectGroup {
  /** Workspace root or session cwd; `undefined` for sessions without a known project. */
  path: string | undefined;
  name: string;
  inWorkspace: boolean;
  sessions: AgentSession[];
  today: { tokens: number; costUsd: number };
}

/**
 * Groups sessions by project. Sessions inside an open workspace folder are grouped
 * under that folder (so a monorepo's packages land together); others by their own cwd.
 */
export function groupByProject(sessions: readonly AgentSession[], workspaceRoots: readonly string[], now: number): ProjectGroup[] {
  const day = dayKeyLocal(now);
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const root = workspaceRoots.find((r) => pathWithin(s.projectPath, r));
    const key = root ?? s.projectPath ?? '';
    let g = groups.get(key);
    if (!g) {
      g = { path: key || undefined, name: projectName(key || undefined), inWorkspace: !!root, sessions: [], today: { tokens: 0, costUsd: 0 } };
      groups.set(key, g);
    }
    g.sessions.push(s);
    const d = s.daily?.[day];
    if (d) {
      g.today.tokens += d.tokens;
      g.today.costUsd += d.costUsd;
    }
  }
  return [...groups.values()].sort((a, b) => {
    if (a.inWorkspace !== b.inWorkspace) return a.inWorkspace ? -1 : 1;
    const la = Math.max(...a.sessions.map((s) => s.updatedAt));
    const lb = Math.max(...b.sessions.map((s) => s.updatedAt));
    return lb - la;
  });
}

export function todayUsage(sessions: readonly AgentSession[], now: number): { tokens: number; costUsd: number; priced: boolean } {
  const day = dayKeyLocal(now);
  let tokens = 0;
  let costUsd = 0;
  let priced = false;
  for (const s of sessions) {
    const d = s.daily?.[day];
    if (!d) continue;
    tokens += d.tokens;
    costUsd += d.costUsd;
    if (s.costUsd !== undefined) priced = true;
  }
  return { tokens, costUsd, priced };
}

export function sessionTokens(s: AgentSession): number | undefined {
  return s.tokens ? totalTokens(s.tokens) : undefined;
}

/** Tokens the session used today (local time), or `undefined` when unknown. */
export function sessionTodayTokens(s: AgentSession, now: number): number | undefined {
  return s.daily?.[dayKeyLocal(now)]?.tokens;
}

function dayKeyLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
