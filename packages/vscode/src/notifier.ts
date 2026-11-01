import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { fmtTokens, progressOf, projectName, sessionTokens, type AgentSession, type SessionStatus, type Snapshot } from '@kvali/core';
import type { KvaliConfig } from './config.ts';

export interface NotifierDeps {
  config(): KvaliConfig;
  /** Whether this window should notify about `s` (avoids duplicates across windows). */
  owns(s: AgentSession): boolean;
  reveal(): void;
}

const FINISH_DEBOUNCE_MS = 2_500;
/** A question answered (or settled by a hook or auto mode's classifier) within this sends nothing. */
const WAITING_DELAY_MS = 5_000;
/** At most one "needs you" notification per session in this time: the status bar shows the rest. */
const WAITING_REPEAT_MS = 60_000;

/** Shows a notification when a session finishes, needs input or fails. */
export class Notifier {
  private readonly prev = new Map<string, SessionStatus>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waitedAt = new Map<string, number>();
  private readonly latest = new Map<string, AgentSession>();
  private readonly startedAt = Date.now();
  private readonly deps: NotifierDeps;

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  update(snapshot: Snapshot): void {
    const seen = new Set<string>();
    for (const s of snapshot.sessions) {
      seen.add(s.key);
      this.latest.set(s.key, s);
      const before = this.prev.get(s.key);
      this.prev.set(s.key, s.status);
      if (s.status === 'working' || s.status === 'waiting') this.cancel(s.key);
      if (s.status !== 'waiting') this.cancelWaiting(s.key);

      if (before === undefined) {
        // First sighting (e.g. right after startup): only a fresh request for input is worth a ping.
        if (s.status === 'waiting' && s.updatedAt > this.startedAt) this.scheduleWaiting(s.key);
        continue;
      }
      if (before === s.status) continue;
      if (s.status === 'waiting') this.scheduleWaiting(s.key);
      else if ((before === 'working' || before === 'waiting') && (s.status === 'idle' || s.status === 'done')) this.schedule(s);
      else if (before === 'working' && s.status === 'error') this.fire('error', s);
    }
    for (const k of [...this.prev.keys()]) {
      if (seen.has(k)) continue;
      this.prev.delete(k);
      this.latest.delete(k);
      this.cancelWaiting(k);
    }
  }

  dispose(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
  }

  private cancelWaiting(key: string): void {
    const t = this.waiting.get(key);
    if (t) clearTimeout(t);
    this.waiting.delete(key);
  }

  /** Notifies once the session has waited a moment, and not again for that session within a minute. */
  private scheduleWaiting(key: string): void {
    if (this.waiting.has(key)) return;
    this.waiting.set(
      key,
      setTimeout(() => {
        this.waiting.delete(key);
        const s = this.latest.get(key);
        if (s?.status !== 'waiting') return;
        const now = Date.now();
        if (now - (this.waitedAt.get(key) ?? -Infinity) < WAITING_REPEAT_MS) return;
        this.waitedAt.set(key, now);
        this.fire('waiting', s);
      }, WAITING_DELAY_MS),
    );
  }

  private cancel(key: string): void {
    const t = this.pending.get(key);
    if (t) clearTimeout(t);
    this.pending.delete(key);
  }

  /** Waits briefly so a turn that immediately continues (queued prompt) does not ping. */
  private schedule(s: AgentSession): void {
    this.cancel(s.key);
    this.pending.set(
      s.key,
      setTimeout(() => {
        this.pending.delete(s.key);
        const now = this.prev.get(s.key);
        if (now === 'idle' || now === 'done') this.fire('finished', s);
      }, FINISH_DEBOUNCE_MS),
    );
  }

  private fire(kind: 'finished' | 'waiting' | 'error', s: AgentSession): void {
    const cfg = this.deps.config();
    if (kind === 'finished' && !cfg.notifyFinish) return;
    if ((kind === 'waiting' || kind === 'error') && !cfg.notifyNeedsInput) return;
    if (!this.deps.owns(s)) return;

    const project = projectName(s.projectPath);
    const p = progressOf(s.tasks);
    const tokens = sessionTokens(s);
    let text: string;
    if (kind === 'finished') {
      const bits = [p.total ? `${p.done}/${p.total} tasks` : undefined, tokens ? `${fmtTokens(tokens)} tokens` : undefined].filter(Boolean);
      text = `${s.agentLabel} finished in ${project}: ${s.title}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    } else if (kind === 'waiting') {
      text = `${s.agentLabel} needs you in ${project}: ${s.statusDetail ?? 'waiting for input'} — ${s.title}`;
    } else {
      text = `${s.agentLabel} stopped with an error in ${project}: ${s.statusDetail ?? s.title}`;
    }

    const show = kind === 'finished' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(text, 'Show').then((choice) => {
      if (choice) this.deps.reveal();
    });
    if (cfg.notifySystem && !vscode.window.state.focused) {
      const title = kind === 'finished' ? `✓ ${s.agentLabel} finished` : kind === 'waiting' ? `⚠ ${s.agentLabel} needs you` : `✕ ${s.agentLabel} error`;
      osNotify(title, `${project} · ${kind === 'waiting' ? (s.statusDetail ?? s.title) : s.title}`);
    }
  }
}

/** Best-effort OS notification. Arguments are passed as argv, never through a shell. */
export function osNotify(title: string, body: string): void {
  const clean = (v: string) => v.replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (process.platform === 'darwin') {
    const q = (v: string) => `"${clean(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    execFile('osascript', ['-e', `display notification ${q(body)} with title ${q(title)}`], () => {});
  } else if (process.platform === 'linux') {
    execFile('notify-send', ['--app-name=Kvali', clean(title), clean(body)], () => {});
  }
}
