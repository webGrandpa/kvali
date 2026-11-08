/** Parses an ISO timestamp (or epoch seconds/ms) into epoch milliseconds. Returns `undefined` when invalid. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

import type { DailyUsage } from '../model.ts';

/** A gap longer than this between an agent's records is a pause, not work. */
export const WORK_GAP_MS = 15 * 60_000;

/**
 * Counts the time since the previous record as work, on the day it ended: called for records
 * the agent itself produced (a response, a tool's result), so the person's own thinking before a
 * prompt is not counted.
 */
export function addWork(daily: Record<string, DailyUsage>, from: number | undefined, to: number): void {
  if (from === undefined || !(to > from) || to - from > WORK_GAP_MS) return;
  const b = (daily[dayKey(to)] ??= { tokens: 0, costUsd: 0 });
  b.activeMs = (b.activeMs ?? 0) + (to - from);
}

/** Counts a plan step finished at `at`. */
export function addTaskDone(daily: Record<string, DailyUsage>, at: number): void {
  const b = (daily[dayKey(at)] ??= { tokens: 0, costUsd: 0 });
  b.tasksDone = (b.tasksDone ?? 0) + 1;
}

/** Local calendar day key, `YYYY-MM-DD`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
