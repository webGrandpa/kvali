/**
 * Phone notifications through ntfy (https://ntfy.sh): free, open source, apps for iOS and
 * Android, no account. Kvali publishes to a topic with an unguessable name; the person
 * subscribes to it in the ntfy app. Self-hosted ntfy servers work the same way.
 *
 * The setup lives in `~/.kvali/config.json`, shared by the editor extension, the CLI and
 * the Claude Code plugin, so one setup covers every way Kvali runs.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtDuration, fmtTokens, projectName, sessionTokens } from './format.ts';
import { currentTask, progressOf, type AgentSession, type SessionStatus, type Snapshot } from './model.ts';

export type PhoneEvent = 'needs-you' | 'done' | 'error' | 'stuck' | 'steps';
export const PHONE_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps'];
/** Step-by-step pushes are opt-in: they are many. */
export const DEFAULT_PHONE_EVENTS: PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck'];
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

export interface PhoneConfig {
  server: string;
  topic: string;
  /** Access token for a protected topic or a self-hosted server. */
  token?: string;
  events: PhoneEvent[];
  /** Include project, task and step names. Off: only the agent and what happened. */
  details: boolean;
}

export const kvaliConfigFile = (home: string): string => path.join(home, '.kvali', 'config.json');

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizePhoneConfig(raw: unknown): PhoneConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.topic !== 'string' || !TOPIC_RE.test(r.topic)) return undefined;
  const server = typeof r.server === 'string' && /^https?:\/\/[^\s/]/.test(r.server) ? r.server.replace(/\/+$/, '') : DEFAULT_NTFY_SERVER;
  const events = Array.isArray(r.events)
    ? r.events.filter((e): e is PhoneEvent => PHONE_EVENTS.includes(e as PhoneEvent))
    : [...DEFAULT_PHONE_EVENTS];
  return { server, topic: r.topic, token: typeof r.token === 'string' && r.token ? r.token : undefined, events, details: r.details !== false };
}

export async function readPhoneConfig(home: string): Promise<PhoneConfig | undefined> {
  try {
    const all = JSON.parse(await fsp.readFile(kvaliConfigFile(home), 'utf8')) as Record<string, unknown> | null;
    return normalizePhoneConfig(all?.phone);
  } catch {
    return undefined;
  }
}

/**
 * Saves the phone setup, or removes it with `undefined`, keeping the rest of the file.
 * The file is the owner's alone: it may hold an access token.
 */
export async function writePhoneConfig(home: string, cfg: PhoneConfig | undefined): Promise<void> {
  const file = kvaliConfigFile(home);
  let all: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
  } catch {
    // new file
  }
  if (cfg) all.phone = { server: cfg.server, topic: cfg.topic, ...(cfg.token ? { token: cfg.token } : {}), events: cfg.events, details: cfg.details };
  else delete all.phone;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => undefined);
}

/** Sets one top-level option in ~/.kvali/config.json (read by the CLI and the Claude Code plugin), keeping the rest. */
export async function setKvaliOption(home: string, key: 'autoPlan', value: boolean): Promise<void> {
  const file = kvaliConfigFile(home);
  let all: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
  } catch {
    // new file
  }
  if (all[key] === value) return;
  all[key] = value;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

/** A topic nobody can guess (80 random bits): on ntfy.sh anyone who knows a topic's name can read it. */
export function newTopic(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 32 letters: no bias, no 0/o or 1/l
  let s = '';
  for (const b of randomBytes(16)) s += alphabet[b % 32];
  return `kvali-${s}`;
}

export function newPhoneConfig(server = DEFAULT_NTFY_SERVER): PhoneConfig {
  return { server: server.replace(/\/+$/, ''), topic: newTopic(), events: [...DEFAULT_PHONE_EVENTS], details: true };
}

/**
 * Opens the ntfy app already subscribed to the topic. Android follows it; on an iPhone the
 * topic is added in the app by name.
 */
export function subscribeLink(cfg: Pick<PhoneConfig, 'server' | 'topic'>): string {
  const u = new URL(cfg.server);
  const base = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  return `ntfy://${base}/${cfg.topic}?display=Kvali${u.protocol === 'http:' ? '&secure=false' : ''}`;
}

export interface PhonePush {
  event: PhoneEvent;
  title: string;
  message: string;
  /** ntfy priorities: 2 low, 3 default, 4 high (pops up). */
  priority: 2 | 3 | 4;
  /** ntfy tags; known emoji names show as an emoji before the title. */
  tags: string[];
}

/** The request that publishes `push`: ntfy's JSON form, so any language and emoji pass intact. */
export function ntfyRequest(cfg: PhoneConfig, push: PhonePush): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const body = JSON.stringify({ topic: cfg.topic, title: push.title, message: push.message, priority: push.priority, tags: push.tags });
  return { url: cfg.server, method: 'POST', headers, body };
}

export type SendResult = { ok: true } | { ok: false; error: string };

export async function sendPush(cfg: PhoneConfig, push: PhonePush, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const req = ntfyRequest(cfg, push);
  try {
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    return { ok: false, error: `${new URL(cfg.server).host} answered ${res.status}${text ? `: ${text}` : ''}` };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    return { ok: false, error: `could not reach ${new URL(cfg.server).host}: ${e.cause?.code ?? e.cause?.message ?? e.message}` };
  }
}

export function testPush(): PhonePush {
  return {
    event: 'done',
    title: 'Kvali is connected',
    message: 'You will get a notification here when an agent needs you, finishes a long task, fails or goes quiet.',
    priority: 3,
    tags: ['white_check_mark'],
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

type Kind = 'needs-you' | 'error' | 'finished' | 'paused' | 'gone' | 'trouble' | 'quiet' | 'step';

/** The words of a push. Without details, no project, task or step names leave the computer. */
export function formatPush(kind: Kind, s: AgentSession, details: boolean, extra: { workedMs?: number; quietMs?: number } = {}): PhonePush {
  const agent = s.agentLabel;
  const where = details ? ` · ${projectName(s.projectPath)}` : '';
  const p = progressOf(s.tasks);
  const step = currentTask(s.tasks);
  const stepName = step ? (step.activeTitle ?? step.title) : undefined;
  const planLine = p.total ? `${p.done}/${p.total} tasks${details && stepName ? ` · ${clip(stepName, 80)}` : ''}` : undefined;
  const title = details ? clip(s.title, 120) : undefined;
  const lines = (...xs: (string | undefined)[]) => xs.filter(Boolean).join('\n');
  switch (kind) {
    case 'needs-you':
      return {
        event: 'needs-you',
        title: `${agent} needs you${where}`,
        message: lines(details ? clip(s.statusDetail ?? 'Waiting for your answer', 200) : 'Waiting for your answer', title, planLine),
        priority: 4,
        tags: ['bell'],
      };
    case 'error':
      return {
        event: 'error',
        title: `${agent} stopped with an error${where}`,
        message: lines(details ? clip(s.statusDetail ?? 'The turn ended with an error', 200) : 'The turn ended with an error', title, planLine),
        priority: 4,
        tags: ['x'],
      };
    case 'finished': {
      const tokens = sessionTokens(s);
      const facts = [extra.workedMs ? `in ${fmtDuration(extra.workedMs)}` : undefined, p.total ? `${p.done}/${p.total} tasks` : undefined, tokens ? `${fmtTokens(tokens)} tokens` : undefined]
        .filter(Boolean)
        .join(' · ');
      return { event: 'done', title: `${agent} finished${where}`, message: lines(title, facts ? `Done ${facts}` : 'Done'), priority: 3, tags: ['white_check_mark'] };
    }
    case 'paused':
      return {
        event: 'done',
        title: `${agent} stopped and is waiting for you${where}`,
        message: lines(title, planLine ? `Stopped at ${planLine}` : undefined),
        priority: 4,
        tags: ['raised_hand'],
      };
    case 'gone':
      return {
        event: 'stuck',
        title: `${agent} stopped responding${where}`,
        message: lines('It was working and went silent: closed, crashed or frozen. Check its window.', title),
        priority: 4,
        tags: ['warning'],
      };
    case 'trouble': {
      const t = s.trouble;
      const retry = t?.attempt ? ` · retry ${t.attempt}${t.maxAttempts ? `/${t.maxAttempts}` : ''}` : '';
      return {
        event: 'stuck',
        title: `${agent}: connection or API problem${where}`,
        message: lines(`${details && t ? clip(t.message, 160) : 'The agent keeps retrying'}${retry}`, title),
        priority: 3,
        tags: ['warning'],
      };
    }
    case 'quiet':
      return {
        event: 'stuck',
        title: `${agent} has been quiet${where}`,
        message: lines(`No output for ${fmtDuration(extra.quietMs ?? 0)} and nothing is running. It may be stuck or offline.`, title),
        priority: 3,
        tags: ['hourglass'],
      };
    case 'step':
      return {
        event: 'steps',
        title: `${agent}${where} · ${p.done}/${p.total}`,
        message: details && stepName ? `Now: ${clip(stepName, 120)}` : `${p.percent}% done`,
        priority: 2,
        tags: ['arrow_forward'],
      };
  }
}

interface Track {
  status: SessionStatus;
  /** When the current working period began. */
  workStart?: number;
  /** When it stopped working; the push waits a moment in case the next turn starts right away. */
  stoppedAt?: number;
  done: number;
  troubleSince?: number;
  troublePushed?: boolean;
  quietPushedFor?: number;
  gonePushedFor?: number;
  lastStepPush?: number;
}

export interface PushPlannerOptions {
  now?: () => number;
  /** Shorter working periods end without a push. */
  minWorkMs?: number;
  /** How long a stop must last to count (a queued prompt starts the next turn at once). */
  settleMs?: number;
  /** Silence with nothing running that is worth a push (agents without the plugin). */
  quietMs?: number;
  /** How long API trouble must last before it is worth a push. */
  troubleMs?: number;
  stepEveryMs?: number;
}

/**
 * Decides which changes are worth a push, from the snapshots Kvali already builds: one
 * push per event, never a stream of them. Claude Code sessions whose Kvali plugin pushes
 * by itself are left to it, except when the agent stops responding, which only an outside
 * observer can tell.
 */
export class PushPlanner {
  private readonly tracks = new Map<string, Track>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly minWorkMs: number;
  private readonly settleMs: number;
  private readonly quietMs: number;
  private readonly troubleMs: number;
  private readonly stepEveryMs: number;

  constructor(opts: PushPlannerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.minWorkMs = opts.minWorkMs ?? 2 * 60_000;
    this.settleMs = opts.settleMs ?? 3_000;
    this.quietMs = opts.quietMs ?? 10 * 60_000;
    this.troubleMs = opts.troubleMs ?? 2 * 60_000;
    this.stepEveryMs = opts.stepEveryMs ?? 60_000;
  }

  observe(snapshot: Snapshot, cfg: Pick<PhoneConfig, 'events' | 'details'>): PhonePush[] {
    const now = this.now();
    const out: PhonePush[] = [];
    const want = (e: PhoneEvent) => cfg.events.includes(e);
    const seen = new Set<string>();
    for (const s of snapshot.sessions) {
      seen.add(s.key);
      const prog = progressOf(s.tasks);
      const active = s.status === 'working' || s.status === 'waiting' || s.status === 'stale';
      const mine = !s.pushedByPlugin;
      const t = this.tracks.get(s.key);
      if (!t) {
        // First sighting (Kvali just started): only a fresh question is worth a push.
        this.tracks.set(s.key, { status: s.status, workStart: active ? (s.turn?.startedAt ?? s.updatedAt) : undefined, done: prog.done });
        if (s.status === 'waiting' && s.updatedAt > this.startedAt && mine && want('needs-you')) out.push(formatPush('needs-you', s, cfg.details));
        continue;
      }

      if (active) {
        t.stoppedAt = undefined;
        if (t.workStart === undefined) t.workStart = s.turn?.startedAt && s.turn.startedAt <= now ? s.turn.startedAt : now;
      }
      if (s.status !== t.status) {
        if (s.status === 'waiting' && mine && want('needs-you')) out.push(formatPush('needs-you', s, cfg.details));
        else if (s.status === 'error' && mine && want('error')) out.push(formatPush('error', s, cfg.details));
        else if ((s.status === 'done' || s.status === 'idle') && (t.status === 'working' || t.status === 'waiting' || t.status === 'stale')) t.stoppedAt = now;
      }

      if (t.stoppedAt !== undefined && (s.status === 'done' || s.status === 'idle') && now - t.stoppedAt >= this.settleMs) {
        const worked = t.workStart !== undefined ? t.stoppedAt - t.workStart : 0;
        const interrupted = s.statusDetail === 'Interrupted';
        if (worked >= this.minWorkMs && !interrupted && mine && want('done')) {
          const unfinished = prog.total > 0 && prog.done < prog.total;
          out.push(formatPush(unfinished ? 'paused' : 'finished', s, cfg.details, { workedMs: worked }));
        }
        t.stoppedAt = undefined;
        t.workStart = undefined;
      }
      if (!active && t.stoppedAt === undefined) t.workStart = undefined;

      // Stuck, offline or failing: once per episode.
      if (s.trouble && now - s.trouble.at < 15 * 60_000 && (s.status === 'working' || s.status === 'stale')) t.troubleSince ??= now;
      else {
        t.troubleSince = undefined;
        t.troublePushed = false;
      }
      if (want('stuck') && (s.status === 'working' || s.status === 'stale')) {
        if (s.pulse?.phase === 'gone') {
          if (t.gonePushedFor !== s.pulse.at) {
            t.gonePushedFor = s.pulse.at;
            out.push(formatPush('gone', s, cfg.details));
          }
        } else if (mine && t.troubleSince !== undefined && !t.troublePushed && now - t.troubleSince >= this.troubleMs) {
          t.troublePushed = true;
          out.push(formatPush('trouble', s, cfg.details));
        } else if (mine && !s.pulse && t.troubleSince === undefined) {
          const a = s.activity;
          const running = !!a && !a.endedAt && a.kind !== 'thinking' && a.kind !== 'message';
          const quiet = now - s.updatedAt;
          if (!running && quiet >= this.quietMs && t.quietPushedFor !== s.updatedAt) {
            t.quietPushedFor = s.updatedAt;
            out.push(formatPush('quiet', s, cfg.details, { quietMs: quiet }));
          }
        }
      }

      if (want('steps') && mine && active && prog.total > 0 && prog.done > t.done && (t.lastStepPush === undefined || now - t.lastStepPush >= this.stepEveryMs)) {
        t.lastStepPush = now;
        out.push(formatPush('step', s, cfg.details));
      }
      t.done = prog.done;
      t.status = s.status;
    }
    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k);
    return out;
  }
}
