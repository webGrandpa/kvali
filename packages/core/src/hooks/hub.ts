/**
 * The hook hub: a tiny HTTP endpoint on 127.0.0.1 that agent hooks POST their
 * events to. It stores the latest event per session under `~/.kvali/live/<agent>/<session>.json`,
 * which adapters read to learn things transcripts do not record (for example
 * "Claude is waiting for your permission").
 *
 * Several editor windows may run Kvali at once. Only one can bind the port; it
 * becomes the hub and is the single writer of the live files, while every window
 * reads them. When the hub window closes, another one takes over the port.
 */
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const DEFAULT_HOOK_PORT = 47821;
const MAX_BODY = 1 << 20;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const AGENTS = new Set(['claude-code', 'codex', 'gemini-cli']);

export interface LiveEvent {
  sessionId: string;
  event: string;
  notificationType?: string;
  message?: string;
  toolName?: string;
  cwd?: string;
  transcriptPath?: string;
  at: number;
}

export interface HookHubOptions {
  port?: number;
  liveDir: string;
  onEvent?: (agent: string, event: LiveEvent) => void;
  /** Optional JSON reply for synchronous hooks (e.g. planning context). Must return quickly. */
  respond?: (agent: string, event: LiveEvent) => object | undefined;
  onRoleChange?: (isHub: boolean) => void;
  log?: (message: string) => void;
  retryMs?: number;
}

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v ? v.slice(0, max) : undefined;
}

/** Maps an agent's raw hook payload onto `LiveEvent`. Never stores prompts or tool inputs. */
export function normalizeHookPayload(agent: string, body: Record<string, unknown>, now = Date.now()): LiveEvent | undefined {
  const sessionId = str(body.session_id ?? body.sessionId, 200);
  if (!sessionId || !SAFE_ID.test(sessionId) || sessionId.includes('..')) return undefined;
  const event = str(body.hook_event_name ?? body.hookEventName ?? body.event, 64) ?? 'unknown';
  return {
    sessionId,
    event,
    notificationType: str(body.notification_type ?? body.notificationType, 64),
    message: event === 'Notification' || event === 'StopFailure' ? str(body.message ?? body.error, 300) : undefined,
    toolName: str(body.tool_name, 120),
    cwd: str(body.cwd, 1000),
    transcriptPath: str(body.transcript_path, 1000),
    at: now,
  };
}

export class HookHub {
  private server: http.Server | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private hub = false;
  private readonly opts: HookHubOptions;
  readonly port: number;

  constructor(opts: HookHubOptions) {
    this.opts = opts;
    this.port = opts.port ?? DEFAULT_HOOK_PORT;
  }

  get isHub(): boolean {
    return this.hub;
  }

  start(): void {
    this.disposed = false;
    this.tryListen();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.server?.close();
    this.server = undefined;
    this.setHub(false);
  }

  private setHub(v: boolean): void {
    if (this.hub === v) return;
    this.hub = v;
    this.opts.onRoleChange?.(v);
  }

  private tryListen(): void {
    if (this.disposed) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on('error', (err: NodeJS.ErrnoException) => {
      server.close();
      this.setHub(false);
      if (err.code !== 'EADDRINUSE') this.opts.log?.(`hook hub: ${err.message}`);
      this.retry = setTimeout(() => this.tryListen(), this.opts.retryMs ?? 15_000);
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.server = server;
      this.setHub(true);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"name":"kvali"}');
      return;
    }
    const m = /^\/v1\/events\/([a-z-]+)$/.exec(url);
    const type = String(req.headers['content-type'] ?? '');
    if (req.method !== 'POST' || !m || !AGENTS.has(m[1]) || !type.includes('application/json')) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const ev = normalizeHookPayload(m[1], body);
      // Answer right away. An empty 200 means "no decision"; a JSON body is read by synchronous hooks.
      let reply: object | undefined;
      try {
        reply = ev ? this.opts.respond?.(m[1], ev) : undefined;
      } catch {
        reply = undefined;
      }
      if (reply) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      else res.writeHead(200).end();
      if (!ev) return;
      await this.store(m[1], ev);
      this.opts.onEvent?.(m[1], ev);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  }

  private async store(agent: string, ev: LiveEvent): Promise<void> {
    const dir = path.join(this.opts.liveDir, agent);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ev.sessionId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(ev));
    await fsp.rename(tmp, file);
  }
}

/** Removes live files older than `maxAgeMs` so the directory never grows unbounded. */
export async function pruneLiveDir(liveDir: string, maxAgeMs = 3 * 86_400_000, now = Date.now()): Promise<void> {
  let agents: string[] = [];
  try {
    agents = await fsp.readdir(liveDir);
  } catch {
    return;
  }
  for (const a of agents) {
    const dir = path.join(liveDir, a);
    let files: string[] = [];
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > maxAgeMs) await fsp.unlink(p);
      } catch {
        /* ignore */
      }
    }
  }
}
