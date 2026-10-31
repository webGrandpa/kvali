import type * as vscode from 'vscode';
import { PhoneNotifier, subscribeLink, type PhoneConfig, type Snapshot } from '@kvali/core';
import type { PhoneView } from './messages.ts';

/**
 * Sends phone notifications for the agents this machine runs. Every window plans (so a
 * window that takes over keeps the history), but only the one holding the hook port sends,
 * so each event reaches the phone once however many windows are open. It looks on every
 * new snapshot and every few seconds besides: a finished task or a silent agent changes
 * nothing the engine would publish.
 */
export class PhoneSender {
  private readonly notifier: PhoneNotifier;

  constructor(home: string, snapshot: () => Snapshot, isHub: () => boolean, log: vscode.LogOutputChannel) {
    this.notifier = new PhoneNotifier({
      home,
      snapshot,
      canSend: isHub,
      report: (line, ok) => (ok ? log.info(`Phone: ${line}`) : log.warn(`Phone notification not sent (${line})`)),
    });
  }

  get config(): PhoneConfig | undefined {
    return this.notifier.config;
  }

  view(): PhoneView | undefined {
    const c = this.notifier.config;
    return c ? { server: c.server, topic: c.topic, link: subscribeLink(c), events: c.events, details: c.details } : undefined;
  }

  /** Re-reads `~/.kvali/config.json` when it changed (the CLI or another window may have set it up). */
  reload(force = false): Promise<void> {
    return this.notifier.reload(force);
  }

  /** Plans from the engine's newest snapshot and sends what is due. */
  update(): Promise<void> {
    return this.notifier.tick();
  }

  start(): void {
    this.notifier.start();
  }

  dispose(): void {
    this.notifier.dispose();
  }
}
