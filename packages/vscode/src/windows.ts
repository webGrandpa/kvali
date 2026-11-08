/**
 * Every Kvali window writes a small heartbeat file listing its workspace folders.
 * The notifier uses it to decide which window owns a session, so a notification
 * is shown exactly once even with several windows open; "Go to agent" uses it to hand
 * a session over to the window that has its project open (a request file in `../focus`).
 */
import { promises as fsp, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { pathWithin } from '@kvali/core';

export interface WindowFile {
  id: string;
  roots: string[];
  /** The `.code-workspace` file of a multi-root window. */
  workspaceFile?: string;
  at: number;
}

interface FocusRequest {
  key: string;
  at: number;
}

const HEARTBEAT_MS = 20_000;
const EXPIRES_MS = 65_000;
/** A request older than this is stale: the person has moved on. */
const FOCUS_FRESH_MS = 15_000;

export class WindowRegistry {
  readonly id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private others: WindowFile[] = [];
  private readonly dir: string;
  private readonly focusDir: string;
  private readonly roots: () => string[];
  private readonly workspaceFile: () => string | undefined;
  private watcher: FSWatcher | undefined;
  private onFocus: ((key: string) => void) | undefined;

  constructor(dir: string, roots: () => string[], workspaceFile: () => string | undefined = () => undefined) {
    this.dir = dir;
    this.focusDir = path.join(path.dirname(dir), 'focus');
    this.roots = roots;
    this.workspaceFile = workspaceFile;
  }

  private get file(): string {
    return path.join(this.dir, `${this.id}.json`);
  }

  private get focusFile(): string {
    return path.join(this.focusDir, `${this.id}.json`);
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
  }

  async beat(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const body: WindowFile = { id: this.id, roots: this.roots(), workspaceFile: this.workspaceFile(), at: Date.now() };
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
    return !!this.ownerOf(projectPath);
  }

  /** Another live window that has `projectPath` in its workspace. */
  ownerOf(projectPath: string | undefined): WindowFile | undefined {
    if (!projectPath) return undefined;
    return this.others.find((w) => w.roots.some((r) => pathWithin(projectPath, r)));
  }

  /** Asks another window to take the person to the session `key`. */
  async requestFocus(windowId: string, key: string): Promise<void> {
    if (!/^[\w.-]+$/.test(windowId)) return;
    await fsp.mkdir(this.focusDir, { recursive: true });
    const body: FocusRequest = { key, at: Date.now() };
    await fsp.writeFile(path.join(this.focusDir, `${windowId}.json`), JSON.stringify(body));
  }

  /** Hears requests other windows make to this one. */
  listen(onFocus: (key: string) => void): void {
    this.onFocus = onFocus;
    void fsp
      .mkdir(this.focusDir, { recursive: true })
      .then(() => {
        try {
          this.watcher = watch(this.focusDir, (_event, name) => {
            if (!name || String(name) === `${this.id}.json`) void this.checkFocus();
          });
          this.watcher.on('error', () => this.watcher?.close());
        } catch {
          /* no file watching here: checkFocus runs with every refresh */
        }
      })
      .catch(() => {});
  }

  /** Takes a pending request for this window, if there is a fresh one. */
  async checkFocus(): Promise<void> {
    if (!this.onFocus) return;
    let text: string;
    try {
      text = await fsp.readFile(this.focusFile, 'utf8');
    } catch {
      return;
    }
    await fsp.unlink(this.focusFile).catch(() => {});
    try {
      const r = JSON.parse(text) as FocusRequest;
      if (typeof r.key === 'string' && Date.now() - r.at < FOCUS_FRESH_MS) this.onFocus(r.key);
    } catch {
      /* half-written: the next one will do */
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    void fsp.unlink(this.file).catch(() => {});
    void fsp.unlink(this.focusFile).catch(() => {});
  }
}
