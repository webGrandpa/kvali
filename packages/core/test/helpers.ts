import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Adapter } from '../src/adapter.ts';
import { Engine } from '../src/engine.ts';
import type { AgentSession } from '../src/model.ts';

export function tmpHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kvali-test-'));
}

export function writeJsonl(file: string, records: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function appendJsonl(file: string, records: unknown[]): void {
  appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A clock pinned to a fixed time so status/staleness logic is deterministic. */
export class Clock {
  t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
  iso(offsetMs = 0): string {
    return new Date(this.t + offsetMs).toISOString();
  }
}

export function engineFor(adapter: Adapter, home: string, clock: Clock, extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}): Engine {
  return new Engine({
    adapters: [adapter],
    home,
    env: {},
    now: clock.now,
    activeWindowMs: 10 * 365 * 86_400_000,
    ...extra,
  });
}

export async function only(engine: Engine): Promise<AgentSession> {
  const snap = await engine.tick();
  if (snap.errors.length) throw new Error(JSON.stringify(snap.errors));
  if (snap.sessions.length !== 1) throw new Error(`expected 1 session, got ${snap.sessions.length}`);
  return snap.sessions[0];
}
