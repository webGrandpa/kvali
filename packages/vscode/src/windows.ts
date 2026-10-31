/**
 * Every Kvali window writes a small heartbeat file listing its workspace folders.
 * The notifier uses it to decide which window owns a session, so a notification
 * is shown exactly once even with several windows open.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathWithin } from '@kvali/core';

interface WindowFile {
  id: string;
  roots: string[];
  at: number;
}

const HEARTBEAT_MS = 20_000;
const EXPIRES_MS = 65_000;

export class WindowRegistry {
  readonly id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private others: WindowFile[] = [];
  private readonly dir: string;
  private readonly roots: () => string[];

  constructor(dir: string, roots: () => string[]) {
    this.dir = dir;
    this.roots = roots;
  }

  private get file(): string {
    return path.join(this.dir, `${this.id}.json`);
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
  }

  async beat(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const body: WindowFile = { id: this.id, roots: this.roots(), at: Date.now() };
      await fsp.writeFile(this.file, JSON.stringify(body));
      const now = Date.now();
      const others: WindowFile[] = [];
      for (const f of await fsp.readdir(this.dir)) {
        if (!f.endsWith('.json') || f === `${this.id}.json`) continue;
        const p = path.join(this.dir, f);
        try {
          const w = JSON.parse(await fsp.readFile(p, 'utf8')) as WindowFile;
          if (now - w.at < EXPIRES_MS) others.push(w);
          else if (now - w.at > 10 * EXPIRES_MS) await fsp.unlink(p).catch(() => {});
        } catch {
          /* half-written or foreign file */
        }
      }
      this.others = others;
    } catch {
      /* best effort */
    }
  }

  /** True when another live window has `projectPath` in its workspace. */
  claimedElsewhere(projectPath: string | undefined): boolean {
    if (!projectPath) return false;
    return this.others.some((w) => w.roots.some((r) => pathWithin(projectPath, r)));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    void fsp.unlink(this.file).catch(() => {});
  }
}
