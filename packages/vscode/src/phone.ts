import { promises as fsp } from 'node:fs';
import type * as vscode from 'vscode';
import { kvaliConfigFile, PushPlanner, readPhoneConfig, sendPush, subscribeLink, type PhoneConfig, type Snapshot } from '@kvali/core';
import type { PhoneView } from './messages.ts';

/**
 * Sends phone notifications for the agents this machine runs. Every window plans (so a
 * window that takes over keeps the history), but only the one holding the hook port sends,
 * so each event reaches the phone once however many windows are open.
 */
export class PhoneSender {
  private cfg: PhoneConfig | undefined;
  private mtime = -1;
  private checkedAt = 0;
  private readonly planner = new PushPlanner();
  private readonly home: string;
  private readonly isHub: () => boolean;
  private readonly log: vscode.LogOutputChannel;

  constructor(home: string, isHub: () => boolean, log: vscode.LogOutputChannel) {
    this.home = home;
    this.isHub = isHub;
    this.log = log;
  }

  get config(): PhoneConfig | undefined {
    return this.cfg;
  }

  view(): PhoneView | undefined {
    const c = this.cfg;
    return c ? { server: c.server, topic: c.topic, link: subscribeLink(c), events: c.events, details: c.details } : undefined;
  }

  /** Re-reads `~/.kvali/config.json` when it changed (the CLI or another window may have set it up). */
  async reload(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.checkedAt < 5_000) return;
    this.checkedAt = now;
    const st = await fsp.stat(kvaliConfigFile(this.home)).catch(() => undefined);
    const mtime = st?.mtimeMs ?? 0;
    if (!force && mtime === this.mtime) return;
    this.mtime = mtime;
    this.cfg = await readPhoneConfig(this.home);
  }

  async update(snapshot: Snapshot): Promise<void> {
    await this.reload();
    const cfg = this.cfg;
    if (!cfg) return;
    const pushes = this.planner.observe(snapshot, cfg);
    if (!pushes.length || !this.isHub()) return;
    for (const p of pushes) {
      const r = await sendPush(cfg, p);
      if (r.ok) this.log.info(`Phone: ${p.title}`);
      else this.log.warn(`Phone notification not sent (${p.title}): ${r.error}`);
    }
  }
}
