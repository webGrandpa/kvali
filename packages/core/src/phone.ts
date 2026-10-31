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
/**
 * Progress (`steps`) is on: it is one silent notification per task that each finished step
 * updates in place (Android; the iPhone app lists each update, silently) and the task's end
 * replaces.
 */
export const DEFAULT_PHONE_EVENTS: PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps'];
/** Kvali 0.5 saved this list as its default, before progress existed: it reads as today's default. */
const DEFAULT_EVENTS_V1: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck'];
const PHONE_CONFIG_VERSION = 2;
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
  let events = Array.isArray(r.events)
    ? r.events.filter((e): e is PhoneEvent => PHONE_EVENTS.includes(e as PhoneEvent))
    : [...DEFAULT_PHONE_EVENTS];
  const v1Default = events.length === DEFAULT_EVENTS_V1.length && DEFAULT_EVENTS_V1.every((e) => events.includes(e));
  if (r.v === undefined && v1Default) events = [...DEFAULT_PHONE_EVENTS];
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
  if (cfg) all.phone = { v: PHONE_CONFIG_VERSION, server: cfg.server, topic: cfg.topic, ...(cfg.token ? { token: cfg.token } : {}), events: cfg.events, details: cfg.details };
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
  /**
   * The notification this one replaces (ntfy's sequence ID): a task's progress updates and
   * its end share one, so the phone shows one notification per task.
   */
  sequence?: string;
}

/** The request that publishes `push`: ntfy's JSON form, so any language and emoji pass intact. */
export function ntfyRequest(cfg: PhoneConfig, push: PhonePush): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const body = JSON.stringify({
    topic: cfg.topic,
    title: push.title,
    message: push.message,
    priority: push.priority,
    tags: push.tags,
    ...(push.sequence ? { sequence_id: push.sequence } : {}),
  });
  return { url: cfg.server, method: 'POST', headers, body };
}

/** A text progress bar that reads on any phone: `███░░░░░░░`. */
export function phoneBar(done: number, total: number, cells = 10): string {
  const filled = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
}

/** A stable short tag for a session key, usable in an ntfy sequence ID (letters, digits, `-`, `_`). */
export function sequenceTag(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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
    message: 'Here you will see an agent’s progress through its plan (silently) and get an alert when it finishes, fails, goes quiet or has waited a minute for your answer.',
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
  const nextName = step ? undefined : s.tasks.find((t) => t.status === 'pending')?.title;
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
        message: lines(`${phoneBar(p.done, p.total)} ${p.percent}%`, details ? (stepName ? `Now: ${clip(stepName, 120)}` : nextName ? `Next: ${clip(nextName, 120)}` : undefined) : undefined),
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
  /** The period's own phone notification (an ntfy sequence ID): its progress and its end replace it. */
  episode?: string;
  /** Tasks done when the last progress update went out, or when the period began. */
  sentDone: number;
  /** The tasks-done count last seen and since when: an update waits until it holds a moment. */
  seenDone: number;
  seenDoneAt: number;
  /** The phone followed this period's progress, so its end is sent however short it was. */
  progressSent: boolean;
  /** Since when the agent waits for the person, and whether that wait was pushed. */
  waitingSince?: number;
  waitPushed?: boolean;
  lastStepPush?: number;
  troubleSince?: number;
  troublePushed?: boolean;
  quietPushedFor?: number;
  gonePushedFor?: number;
}

export interface PushPlannerOptions {
  now?: () => number;
  /** Shorter working periods end without a push (unless the phone followed their progress). */
  minWorkMs?: number;
  /** How long a stop must last to count (a queued prompt starts the next turn at once). */
  settleMs?: number;
  /**
   * How long a question (or a stop in the middle of a plan) must wait before it is worth a
   * push: one answered sooner was answered at the computer.
   */
  needsYouAfterMs?: number;
  /** Silence with nothing running that is worth a push (agents without the plugin). */
  quietMs?: number;
  /** How long API trouble must last before it is worth a push. */
  troubleMs?: number;
  /** At most one progress update this often; a step finished sooner goes out with the next one. */
  stepEveryMs?: number;
  /**
   * How long a new tasks-done count must hold before it goes out: an agent marks a task done
   * and the next one in progress in two calls, and the update should name the next one.
   */
  progressSettleMs?: number;
}

/**
 * Decides which changes are worth a push, from the snapshots Kvali already builds: one
 * push per event, never a stream of them. Claude Code sessions whose Kvali plugin pushes
 * by itself are left to it, except when the agent stops responding, which only an outside
 * observer can tell.
 *
 * Several decisions are about time passing (a stop that settles, silence, lasting API
 * trouble, the next progress update), so call `observe` on a clock as well as on every new
 * snapshot: `PhoneNotifier` does both.
 */
export class PushPlanner {
  private readonly tracks = new Map<string, Track>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly minWorkMs: number;
  private readonly settleMs: number;
  private readonly needsYouAfterMs: number;
  private readonly quietMs: number;
  private readonly troubleMs: number;
  private readonly stepEveryMs: number;
  private readonly progressSettleMs: number;

  constructor(opts: PushPlannerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.minWorkMs = opts.minWorkMs ?? 2 * 60_000;
    this.settleMs = opts.settleMs ?? 3_000;
    this.needsYouAfterMs = opts.needsYouAfterMs ?? 60_000;
    this.quietMs = opts.quietMs ?? 10 * 60_000;
    this.troubleMs = opts.troubleMs ?? 2 * 60_000;
    this.stepEveryMs = opts.stepEveryMs ?? 60_000;
    this.progressSettleMs = opts.progressSettleMs ?? 2_000;
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
        const fresh: Track = { status: s.status, sentDone: prog.done, seenDone: prog.done, seenDoneAt: now, progressSent: false };
        if (active) begin(fresh, s.key, s.turn?.startedAt ?? s.updatedAt);
        if (s.status === 'waiting') {
          // A question older than Kvali is not news; a fresh one waits like any other.
          fresh.waitingSince = s.updatedAt > this.startedAt ? s.updatedAt : undefined;
          fresh.waitPushed = s.updatedAt <= this.startedAt;
        }
        this.tracks.set(s.key, fresh);
        continue;
      }

      if (active) {
        t.stoppedAt = undefined;
        if (t.workStart === undefined) begin(t, s.key, s.turn?.startedAt && s.turn.startedAt <= now ? s.turn.startedAt : now);
      }
      if (s.status !== t.status) {
        if (s.status === 'waiting') {
          t.waitingSince = now;
          t.waitPushed = false;
        } else if (s.status === 'error' && mine && want('error')) out.push({ ...formatPush('error', s, cfg.details), sequence: t.episode });
        else if ((s.status === 'done' || s.status === 'idle') && (t.status === 'working' || t.status === 'waiting' || t.status === 'stale')) t.stoppedAt = now;
      }

      // The question itself: only when nobody answered it at the computer for a while.
      if (s.status !== 'waiting') {
        t.waitingSince = undefined;
        t.waitPushed = false;
      } else if (t.waitingSince !== undefined && !t.waitPushed && now - t.waitingSince >= this.needsYouAfterMs) {
        t.waitPushed = true;
        if (mine && want('needs-you')) out.push(formatPush('needs-you', s, cfg.details));
      }

      if (t.stoppedAt !== undefined && (s.status === 'done' || s.status === 'idle') && now - t.stoppedAt >= this.settleMs) {
        const worked = t.workStart !== undefined ? t.stoppedAt - t.workStart : 0;
        const interrupted = s.statusDetail === 'Interrupted';
        const worth = (worked >= this.minWorkMs || t.progressSent) && !interrupted && mine && want('done');
        const unfinished = prog.total > 0 && prog.done < prog.total;
        // A stop in the middle of a plan asks the person something: it waits like a question.
        if (!(worth && unfinished && now - t.stoppedAt < this.needsYouAfterMs)) {
          if (worth) out.push({ ...formatPush(unfinished ? 'paused' : 'finished', s, cfg.details, { workedMs: worked }), sequence: t.episode });
          end(t, prog.done);
        }
      }
      if (!active && t.stoppedAt === undefined) end(t, prog.done);

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
          // Silence that began before Kvali started counts from then: old silence is not news.
          const quietFor = now - Math.max(s.updatedAt, this.startedAt);
          if (!running && quietFor >= this.quietMs && t.quietPushedFor !== s.updatedAt) {
            t.quietPushedFor = s.updatedAt;
            out.push(formatPush('quiet', s, cfg.details, { quietMs: now - s.updatedAt }));
          }
        }
      }

      // Progress: the period's notification shows the latest finished step, at most once a minute.
      if (prog.done < t.sentDone) t.sentDone = prog.done; // a new plan
      if (prog.done !== t.seenDone) {
        t.seenDone = prog.done;
        t.seenDoneAt = now;
      }
      const stepDue = (t.lastStepPush === undefined || now - t.lastStepPush >= this.stepEveryMs) && now - t.seenDoneAt >= this.progressSettleMs;
      if (want('steps') && mine && active && prog.total > 0 && prog.done > t.sentDone && prog.done < prog.total && stepDue) {
        t.lastStepPush = now;
        t.sentDone = prog.done;
        t.progressSent = true;
        out.push({ ...formatPush('step', s, cfg.details), sequence: t.episode });
      }
      t.status = s.status;
    }
    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k);
    return out;
  }
}

function begin(t: Track, key: string, at: number): void {
  t.workStart = at;
  t.episode = `kvali-${sequenceTag(key)}-${Math.max(0, Math.floor(at)).toString(36)}`;
  t.progressSent = false;
}

function end(t: Track, done: number): void {
  t.workStart = undefined;
  t.stoppedAt = undefined;
  t.episode = undefined;
  t.progressSent = false;
  t.sentDone = done;
}

export interface PhoneNotifierOptions {
  home: string;
  /** The newest snapshot (the engine's `snapshot`). */
  snapshot: () => Snapshot;
  /** Whether this process sends: only the one holding the hook port, so each event arrives once. */
  canSend: () => boolean;
  /** Called for each push sent (`ok`) or not sent, with the reason. */
  report?: (line: string, ok: boolean) => void;
  /** How often the planner looks again when nothing changed. */
  everyMs?: number;
  planner?: PushPlanner;
  send?: (cfg: PhoneConfig, push: PhonePush) => Promise<SendResult>;
}

/**
 * Phone notifications for a running Kvali (an editor window, the terminal dashboard,
 * `kvali watch`): plans on every new snapshot and on its own clock, because the engine
 * publishes a snapshot only when something changed, and "it finished", "it went quiet" and
 * "the next progress update" come from time passing, not from a change.
 */
export class PhoneNotifier {
  private cfg: PhoneConfig | undefined;
  private mtime = -1;
  private checkedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private readonly planner: PushPlanner;
  private readonly opts: PhoneNotifierOptions;

  constructor(opts: PhoneNotifierOptions) {
    this.opts = opts;
    this.planner = opts.planner ?? new PushPlanner();
  }

  get config(): PhoneConfig | undefined {
    return this.cfg;
  }

  /** Re-reads `~/.kvali/config.json` when it changed (the CLI, another window or the plugin's owner may have set it up). */
  async reload(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.checkedAt < 5_000) return;
    this.checkedAt = now;
    const st = await fsp.stat(kvaliConfigFile(this.opts.home)).catch(() => undefined);
    const mtime = st?.mtimeMs ?? 0;
    if (!force && mtime === this.mtime) return;
    this.mtime = mtime;
    this.cfg = await readPhoneConfig(this.opts.home);
  }

  /**
   * Plans from the newest snapshot and sends what is due. One run at a time, so an older
   * snapshot never lands after a newer one; calls made meanwhile fold into one more run.
   */
  tick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again);
      } finally {
        this.running = undefined;
      }
    })();
    this.running = run;
    return run;
  }

  /** Looks again every few seconds until `dispose`. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs ?? 5_000);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async once(): Promise<void> {
    await this.reload();
    const cfg = this.cfg;
    if (!cfg) return;
    const pushes = this.planner.observe(this.opts.snapshot(), cfg);
    if (!pushes.length || !this.opts.canSend()) return;
    const send = this.opts.send ?? sendPush;
    for (const p of pushes) {
      const r = await send(cfg, p);
      this.opts.report?.(r.ok ? p.title : `${p.title}: ${r.error}`, r.ok);
    }
  }
}
