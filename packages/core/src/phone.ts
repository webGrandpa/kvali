/**
 * Phone notifications through ntfy (https://ntfy.sh): free, open source, apps for iOS and
 * Android, no account. Kvali publishes to a topic with an unguessable name; the person
 * subscribes to it in the ntfy app. Self-hosted ntfy servers work the same way. A Telegram
 * bot of the person's own and a Discord channel's webhook can receive the same notifications,
 * besides ntfy or instead of it.
 *
 * The setup lives in `~/.kvali/config.json`, shared by the editor extension, the CLI and
 * the Claude Code plugin, so one setup covers every way Kvali runs.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fmtAbout, fmtClock, fmtDuration, fmtEta, fmtTokens, planEta, projectName, sessionTokens } from './format.ts';
import type { AgentLimits } from './limits.ts';
import { currentTask, progressOf, type AgentSession, type RateLimitWindow, type SessionStatus, type Snapshot } from './model.ts';

/**
 * What the phone hears about, each chosen by the person:
 * - `needs-you`: a question (or a stop in the middle of a plan) has waited a minute.
 * - `done`: a task finished, when it worked at least `doneAfterSec` (or the phone followed it).
 * - `steps`: each finished plan step, as the task's silent live notification.
 * - `actions`: what the agent is doing right now, in that same live notification.
 * - `error`, `stuck`: an error stopped the agent; it went silent, stopped responding or goes in circles.
 * - `limits`: a plan's usage window will run out before it resets, or is 90% used.
 */
export type PhoneEvent = 'needs-you' | 'done' | 'error' | 'stuck' | 'steps' | 'actions' | 'limits';
export const PHONE_EVENTS: readonly PhoneEvent[] = ['needs-you', 'done', 'steps', 'actions', 'error', 'stuck', 'limits'];
/**
 * Progress (`steps`) is on: it is one silent notification per task that each finished step
 * updates in place (Android; the iPhone app lists each update, silently) and the task's end
 * replaces.
 */
export const DEFAULT_PHONE_EVENTS: PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps', 'limits'];
/** Kvali 0.5 saved this list as its default, before progress existed: it reads as today's default. */
const DEFAULT_EVENTS_V1: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck'];
/** Kvali 0.6 saved this one, before limits: it reads as today's default too. */
const DEFAULT_EVENTS_V2: readonly PhoneEvent[] = ['needs-you', 'done', 'error', 'stuck', 'steps'];
const PHONE_CONFIG_VERSION = 3;
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
/** A task's end is pushed when it worked at least this long (seconds), unless the person chose otherwise. */
export const DEFAULT_DONE_AFTER_SEC = 120;
/** The task lengths offered in the editor: every task, 30 seconds, 2 minutes, 5 minutes. */
export const DONE_AFTER_CHOICES: readonly number[] = [0, 30, 120, 300];

/** A Telegram bot the person made with @BotFather, and their chat with it. */
export interface TelegramChannel {
  token: string;
  chatId: string;
  /** The bot's username, shown in the editor. */
  bot?: string;
}

/** A Discord channel's webhook (Channel settings → Integrations → Webhooks). */
export interface DiscordChannel {
  webhook: string;
}

export interface PhoneConfig {
  /** The ntfy server. */
  server: string;
  /** The ntfy topic; absent when only Telegram or Discord receives the notifications. */
  topic?: string;
  /** Access token for a protected topic or a self-hosted server. */
  token?: string;
  telegram?: TelegramChannel;
  discord?: DiscordChannel;
  events: PhoneEvent[];
  /** Include project, task and step names. Off: only the agent and what happened. */
  details: boolean;
  /**
   * `done` is pushed for a task that worked at least this many seconds (0: every task), and
   * always for one whose progress the phone followed. Unset: DEFAULT_DONE_AFTER_SEC.
   */
  doneAfterSec?: number;
}

export const kvaliConfigFile = (home: string): string => path.join(home, '.kvali', 'config.json');

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;

function normalizeTelegram(raw: unknown): TelegramChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const chatId = typeof t.chatId === 'number' ? String(t.chatId) : t.chatId;
  if (typeof t.token !== 'string' || !TELEGRAM_TOKEN_RE.test(t.token) || typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) return undefined;
  return { token: t.token, chatId, ...(typeof t.bot === 'string' && /^\w{3,64}$/.test(t.bot) ? { bot: t.bot } : {}) };
}

function normalizeDiscord(raw: unknown): DiscordChannel | undefined {
  const w = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).webhook : undefined;
  return typeof w === 'string' && DISCORD_WEBHOOK_RE.test(w) ? { webhook: w } : undefined;
}

export function normalizePhoneConfig(raw: unknown): PhoneConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const topic = typeof r.topic === 'string' && TOPIC_RE.test(r.topic) ? r.topic : undefined;
  const telegram = normalizeTelegram(r.telegram);
  const discord = normalizeDiscord(r.discord);
  if (!topic && !telegram && !discord) return undefined;
  const server = typeof r.server === 'string' && /^https?:\/\/[^\s/]/.test(r.server) ? r.server.replace(/\/+$/, '') : DEFAULT_NTFY_SERVER;
  let events = Array.isArray(r.events)
    ? r.events.filter((e): e is PhoneEvent => PHONE_EVENTS.includes(e as PhoneEvent))
    : [...DEFAULT_PHONE_EVENTS];
  const same = (list: readonly PhoneEvent[]) => events.length === list.length && list.every((e) => events.includes(e));
  if ((r.v === undefined && same(DEFAULT_EVENTS_V1)) || (r.v === 2 && same(DEFAULT_EVENTS_V2))) events = [...DEFAULT_PHONE_EVENTS];
  const doneAfterSec =
    typeof r.doneAfter === 'number' && Number.isFinite(r.doneAfter) && r.doneAfter >= 0 ? Math.min(Math.round(r.doneAfter), 86_400) : DEFAULT_DONE_AFTER_SEC;
  return {
    server,
    ...(topic ? { topic } : {}),
    token: typeof r.token === 'string' && r.token ? r.token : undefined,
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {}),
    events,
    details: r.details !== false,
    doneAfterSec,
  };
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
  if (cfg)
    all.phone = {
      v: PHONE_CONFIG_VERSION,
      server: cfg.server,
      ...(cfg.topic ? { topic: cfg.topic } : {}),
      ...(cfg.token ? { token: cfg.token } : {}),
      ...(cfg.telegram ? { telegram: cfg.telegram } : {}),
      ...(cfg.discord ? { discord: cfg.discord } : {}),
      events: cfg.events,
      details: cfg.details,
      doneAfter: cfg.doneAfterSec ?? DEFAULT_DONE_AFTER_SEC,
    };
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
export function subscribeLink(cfg: { server: string; topic: string }): string {
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
export function ntfyRequest(cfg: PhoneConfig & { topic: string }, push: PhonePush): { url: string; method: 'POST'; headers: Record<string, string>; body: string } {
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

/** What a channel's server answered, in words that name the host only (never a token or a webhook). */
async function answerOf(res: Response, host: string): Promise<string> {
  const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
  return `${host} answered ${res.status}${text ? `: ${text}` : ''}`;
}

function unreachable(err: unknown, host: string): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return `could not reach ${host}: ${e.cause?.code ?? e.cause?.message ?? e.message}`;
}

/** The emoji ntfy shows for a push's tags, for channels that show text only. */
const TAG_EMOJI: Record<string, string> = {
  white_check_mark: '✅',
  bell: '🔔',
  x: '❌',
  raised_hand: '✋',
  warning: '⚠️',
  hourglass: '⏳',
  hourglass_flowing_sand: '⏳',
  repeat: '🔁',
  arrow_forward: '▶️',
};
const emojiOf = (push: PhonePush): string | undefined => push.tags.map((t) => TAG_EMOJI[t]).find(Boolean);

/** Discord embed colors by what happened. */
const EVENT_COLOR: Record<PhoneEvent, number> = {
  'needs-you': 0xd29922,
  done: 0x3fb950,
  steps: 0x58a6ff,
  actions: 0x58a6ff,
  error: 0xf85149,
  stuck: 0xdb6d28,
  limits: 0xd29922,
};

const escapeHtml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram's Bot API request for a push: bold title, the message below it. */
export function telegramText(push: PhonePush): string {
  const emoji = emojiOf(push);
  return `${emoji ? `${emoji} ` : ''}<b>${escapeHtml(push.title)}</b>${push.message ? `\n${escapeHtml(push.message)}` : ''}`;
}

/** Discord's webhook body for a push: one embed; silent updates do not notify. */
export function discordBody(push: PhonePush): Record<string, unknown> {
  const emoji = emojiOf(push);
  return {
    username: 'Kvali',
    allowed_mentions: { parse: [] },
    embeds: [{ title: `${emoji ? `${emoji} ` : ''}${push.title}`.slice(0, 256), description: push.message.slice(0, 4_000), color: EVENT_COLOR[push.event] }],
    ...(push.priority <= 2 ? { flags: 4_096 } : {}),
  };
}

/**
 * Publishes pushes to every channel set up: ntfy, Telegram, Discord. A push with a `sequence`
 * replaces the earlier one of that sequence, so a task keeps one notification: ntfy does that
 * itself; on Telegram and Discord a silent update edits the message, and an alert (a task's end)
 * replaces it with a new message, which notifies. The message ids live with the sender.
 */
export class PushSender {
  private readonly telegramIds = new Map<string, number>();
  private readonly discordIds = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async send(cfg: PhoneConfig, push: PhonePush): Promise<SendResult> {
    const errors: string[] = [];
    if (cfg.topic) {
      const e = await this.ntfy(cfg as PhoneConfig & { topic: string }, push);
      if (e) errors.push(e);
    }
    if (cfg.telegram) {
      const e = await this.telegram(cfg.telegram, push);
      if (e) errors.push(e);
    }
    if (cfg.discord) {
      const e = await this.discord(cfg.discord, push);
      if (e) errors.push(e);
    }
    this.trim();
    return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
  }

  private async ntfy(cfg: PhoneConfig & { topic: string }, push: PhonePush): Promise<string | undefined> {
    const req = ntfyRequest(cfg, push);
    const host = new URL(cfg.server).host;
    try {
      const res = await this.fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
      return res.ok ? undefined : await answerOf(res, host);
    } catch (err) {
      return unreachable(err, host);
    }
  }

  private async telegramCall(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
    const host = 'api.telegram.org';
    try {
      const res = await this.fetchImpl(`https://${host}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, result: ((await res.json().catch(() => ({}))) as { result?: unknown }).result };
      return { ok: false, error: await answerOf(res, host) };
    } catch (err) {
      return { ok: false, error: unreachable(err, host) };
    }
  }

  private async telegram(t: TelegramChannel, push: PhonePush): Promise<string | undefined> {
    const text = telegramText(push);
    const prev = push.sequence ? this.telegramIds.get(push.sequence) : undefined;
    if (prev !== undefined && push.priority <= 2) {
      const r = await this.telegramCall(t.token, 'editMessageText', { chat_id: t.chatId, message_id: prev, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      if (r.ok || /not modified/i.test(r.error ?? '')) return undefined;
    } else if (prev !== undefined) {
      await this.telegramCall(t.token, 'deleteMessage', { chat_id: t.chatId, message_id: prev });
    }
    const r = await this.telegramCall(t.token, 'sendMessage', {
      chat_id: t.chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: push.priority <= 2,
      link_preview_options: { is_disabled: true },
    });
    if (!r.ok) return r.error;
    if (push.sequence && typeof r.result?.message_id === 'number') this.telegramIds.set(push.sequence, r.result.message_id);
    return undefined;
  }

  private async discord(d: DiscordChannel, push: PhonePush): Promise<string | undefined> {
    const host = 'discord.com';
    const body = discordBody(push);
    const prev = push.sequence ? this.discordIds.get(push.sequence) : undefined;
    const call = (url: string, method: string, json?: unknown) =>
      this.fetchImpl(url, { method, headers: { 'Content-Type': 'application/json' }, ...(json ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(10_000) });
    try {
      if (prev !== undefined && push.priority <= 2) {
        const { flags: _silent, ...edit } = body;
        const res = await call(`${d.webhook}/messages/${prev}`, 'PATCH', edit);
        if (res.ok) return undefined;
      } else if (prev !== undefined) {
        await call(`${d.webhook}/messages/${prev}`, 'DELETE').catch(() => undefined);
      }
      const res = await call(`${d.webhook}?wait=true`, 'POST', body);
      if (!res.ok) return await answerOf(res, host);
      const id = ((await res.json().catch(() => ({}))) as { id?: unknown }).id;
      if (push.sequence && typeof id === 'string') this.discordIds.set(push.sequence, id);
      return undefined;
    } catch (err) {
      return unreachable(err, host);
    }
  }

  /** Message ids of old sequences are forgotten: only the latest tasks are ever updated. */
  private trim(): void {
    for (const m of [this.telegramIds, this.discordIds] as Map<string, unknown>[]) {
      while (m.size > 50) m.delete(m.keys().next().value!);
    }
  }
}

/** Sends one push to every channel set up (no in-place updates across calls: use a `PushSender` for those). */
export async function sendPush(cfg: PhoneConfig, push: PhonePush, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  return new PushSender(fetchImpl).send(cfg, push);
}

/** Which channels are set up, for messages: "ntfy, Telegram". */
export function channelNames(cfg: PhoneConfig): string {
  return [cfg.topic ? 'ntfy' : undefined, cfg.telegram ? 'Telegram' : undefined, cfg.discord ? 'Discord' : undefined].filter(Boolean).join(', ');
}

/** The bot's username when the token works, or why it does not. */
export async function telegramBot(token: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  if (!TELEGRAM_TOKEN_RE.test(token)) return { ok: false, error: 'that is not a bot token (it looks like 123456789:AAF…)' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: res.status === 401 || res.status === 404 ? 'Telegram does not know this token' : await answerOf(res, 'api.telegram.org') };
    const me = ((await res.json()) as { result?: { username?: unknown } }).result;
    return typeof me?.username === 'string' ? { ok: true, username: me.username } : { ok: false, error: 'Telegram sent no bot name' };
  } catch (err) {
    return { ok: false, error: unreachable(err, 'api.telegram.org') };
  }
}

/**
 * Waits for the person to send their bot a message and returns the chat it came from: the
 * bot may only write to people who wrote to it first. Long-polls `getUpdates` until `waitMs`.
 */
export async function telegramFindChat(token: string, waitMs = 120_000, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string | undefined> {
  const until = Date.now() + waitMs;
  let offset: number | undefined;
  while (Date.now() < until && !signal?.aborted) {
    const timeout = Math.max(1, Math.min(25, Math.round((until - Date.now()) / 1000)));
    const askedAt = Date.now();
    let updates: { update_id: number; message?: { chat?: { id?: number; type?: string } } }[] = [];
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?timeout=${timeout}${offset !== undefined ? `&offset=${offset}` : ''}`, {
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      });
      if (!res.ok) return undefined;
      updates = ((await res.json()) as { result?: typeof updates }).result ?? [];
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    const chat = [...updates].reverse().find((u) => u.message?.chat?.type === 'private' && typeof u.message.chat.id === 'number')?.message?.chat?.id;
    if (updates.length) offset = updates[updates.length - 1]!.update_id + 1;
    if (chat !== undefined) {
      // Acknowledge what was read, so the next setup does not find this message again.
      await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      return String(chat);
    }
    // A server that answers at once instead of waiting is asked again a second later.
    if (Date.now() - askedAt < 1_000) await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}

/** Whether a Discord webhook exists (Discord answers its channel's details to anyone who has the URL). */
export async function discordCheck(webhook: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; name?: string } | { ok: false; error: string }> {
  if (!DISCORD_WEBHOOK_RE.test(webhook)) return { ok: false, error: 'that is not a Discord webhook URL (https://discord.com/api/webhooks/…)' };
  try {
    const res = await fetchImpl(webhook, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: res.status === 401 || res.status === 404 ? 'Discord does not know this webhook' : await answerOf(res, 'discord.com') };
    const w = (await res.json().catch(() => ({}))) as { name?: unknown };
    return { ok: true, name: typeof w.name === 'string' ? w.name : undefined };
  } catch (err) {
    return { ok: false, error: unreachable(err, 'discord.com') };
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

type Kind = 'needs-you' | 'error' | 'finished' | 'paused' | 'gone' | 'trouble' | 'quiet' | 'loop' | 'step';

/**
 * The words of a push. Without details, no project, task or step names leave the computer;
 * a session title taken from the person's own first message never does.
 */
export function formatPush(
  kind: Kind,
  s: AgentSession,
  details: boolean,
  extra: { workedMs?: number; quietMs?: number; action?: boolean; now?: number } = {},
): PhonePush {
  const agent = s.agentLabel;
  const where = details ? ` · ${projectName(s.projectPath)}` : '';
  const p = progressOf(s.tasks);
  const step = currentTask(s.tasks);
  const stepName = step ? (step.activeTitle ?? step.title) : undefined;
  const nextName = step ? undefined : s.tasks.find((t) => t.status === 'pending')?.title;
  const planLine = p.total ? `${p.done}/${p.total} tasks${details && stepName ? ` · ${clip(stepName, 80)}` : ''}` : undefined;
  const title = details && !s.titleFromPrompt ? clip(s.title, 120) : undefined;
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
    case 'loop': {
      const l = s.loop;
      const what = l ? (details ? `“${clip(l.detail ?? l.label, 80)}”` : 'The same action') : 'An action';
      const facts = l
        ? [`failed ${l.count} times in a row${l.sameError ? ' with the same error' : ''}`, `for ${fmtDuration((extra.now ?? Date.now()) - l.since)}`, l.tokens ? `${fmtTokens(l.tokens)} tokens` : undefined]
        : ['keeps failing'];
      return {
        event: 'stuck',
        title: `${agent} is going in circles${where}`,
        message: lines(`${what} ${facts.filter(Boolean).join(' · ')}. It may need a hint from you.`, title),
        priority: 4,
        tags: ['repeat'],
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
    case 'step': {
      // The task's live notification: the plan's progress and, when asked, the action running now.
      const doing = extra.action && s.activity && !s.activity.endedAt ? s.activity.label : undefined;
      const stepLine = details ? (stepName ? `Now: ${clip(stepName, 120)}` : nextName ? `Next: ${clip(nextName, 120)}` : undefined) : undefined;
      const eta = extra.now !== undefined ? planEta(s, extra.now) : undefined;
      return {
        event: extra.action ? 'actions' : 'steps',
        title: p.total ? `${agent}${where} · ${p.done}/${p.total}` : `${agent}${where} · working`,
        message:
          lines(
            p.total ? `${phoneBar(p.done, p.total)} ${p.percent}%${eta !== undefined ? ` · ${fmtEta(eta)}` : ''}` : undefined,
            stepLine,
            details && doing ? `Doing: ${clip(doing, 120)}` : undefined,
          ) || 'Working',
        priority: 2,
        tags: ['arrow_forward'],
      };
    }
  }
}

/**
 * A usage window running low: before it runs out at the recent pace, or once it is 90% used.
 * Limits name no project or task, so they read the same with or without details.
 */
export function limitPush(l: Pick<AgentLimits, 'agentLabel'>, w: RateLimitWindow, now: number): PhonePush {
  const used = `${Math.round(w.usedPercent)}% used`;
  const reset = w.resetsAt !== undefined && w.resetsAt > now ? `it resets at ${fmtClock(w.resetsAt)}` : undefined;
  if (w.runsOutAt !== undefined) {
    return {
      event: 'limits',
      title: `${l.agentLabel}: ${w.label} limit runs out in ${fmtAbout(w.runsOutAt - now)}`,
      message: `${used}. At the pace of the last hour it is used up around ${fmtClock(w.runsOutAt)}${reset ? `; ${reset}` : ''}.`,
      priority: 4,
      tags: ['hourglass_flowing_sand'],
    };
  }
  return {
    event: 'limits',
    title: `${l.agentLabel}: ${w.label} limit ${used}`,
    message: reset ? `${reset[0]!.toUpperCase()}${reset.slice(1)}.` : 'Most of this usage window is used.',
    priority: 3,
    tags: ['warning'],
  };
}

/** How soon a window's forecast end is worth a push. */
const LIMIT_SOON_MS = 60 * 60_000;
const LIMIT_HIGH_PCT = 90;

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
  /** The last live update (a step or an action), and the action it showed. */
  lastLivePush?: number;
  sentAction?: string;
  troubleSince?: number;
  troublePushed?: boolean;
  quietPushedFor?: number;
  gonePushedFor?: number;
  /** The loop (its start) last pushed. */
  loopPushedFor?: number;
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
  /** With `actions` on: at most one update about the running action this often. */
  actionEveryMs?: number;
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
  /** Usage windows seen (agent, label, reset), and whether each was pushed. */
  private readonly limitsSeen = new Map<string, boolean>();
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly minWorkMs: number;
  private readonly settleMs: number;
  private readonly needsYouAfterMs: number;
  private readonly quietMs: number;
  private readonly troubleMs: number;
  private readonly stepEveryMs: number;
  private readonly progressSettleMs: number;
  private readonly actionEveryMs: number;

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
    this.actionEveryMs = opts.actionEveryMs ?? 30_000;
  }

  observe(snapshot: Snapshot, cfg: Pick<PhoneConfig, 'events' | 'details' | 'doneAfterSec'>): PhonePush[] {
    const now = this.now();
    const out: PhonePush[] = [];
    const want = (e: PhoneEvent) => cfg.events.includes(e);
    const minWork = cfg.doneAfterSec !== undefined ? cfg.doneAfterSec * 1000 : this.minWorkMs;
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
        const worth = (worked >= minWork || t.progressSent) && !interrupted && mine && want('done');
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
      if (want('stuck') && mine && s.loop && t.loopPushedFor !== s.loop.since) {
        t.loopPushedFor = s.loop.since;
        out.push(formatPush('loop', s, cfg.details, { now }));
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

      // The period's live notification: the latest finished step (at most once a minute) and,
      // when chosen, the action running now (at most twice a minute). One update carries both.
      if (prog.done < t.sentDone) t.sentDone = prog.done; // a new plan
      if (prog.done !== t.seenDone) {
        t.seenDone = prog.done;
        t.seenDoneAt = now;
      }
      const stepNews =
        want('steps') &&
        prog.total > 0 &&
        prog.done > t.sentDone &&
        prog.done < prog.total &&
        now - t.seenDoneAt >= this.progressSettleMs &&
        (t.lastStepPush === undefined || now - t.lastStepPush >= this.stepEveryMs);
      const a = s.activity;
      const actionKey = a && !a.endedAt && a.kind !== 'thinking' && a.kind !== 'message' ? `${a.label}|${a.startedAt}` : undefined;
      const actionNews =
        want('actions') && actionKey !== undefined && actionKey !== t.sentAction && (t.lastLivePush === undefined || now - t.lastLivePush >= this.actionEveryMs);
      if (mine && active && (stepNews || actionNews)) {
        t.lastLivePush = now;
        if (stepNews) {
          t.lastStepPush = now;
          t.sentDone = prog.done;
        }
        if (actionKey !== undefined) t.sentAction = actionKey;
        t.progressSent = true;
        out.push({ ...formatPush('step', s, cfg.details, { action: want('actions'), now }), sequence: t.episode });
      }
      t.status = s.status;
    }
    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k);
    out.push(...this.observeLimits(snapshot.limits, now, want('limits')));
    return out;
  }

  /**
   * One push per usage window: when its forecast end comes within the hour before it resets,
   * or when it passes 90%. A window already low when Kvali starts is not news.
   */
  private observeLimits(limits: readonly AgentLimits[] | undefined, now: number, wanted: boolean): PhonePush[] {
    const out: PhonePush[] = [];
    for (const l of limits ?? []) {
      for (const w of l.windows) {
        const key = `${l.agent}|${w.label}|${w.resetsAt === undefined ? '' : Math.round(w.resetsAt / 600_000)}`;
        const pressing = (w.runsOutAt !== undefined && w.runsOutAt - now <= LIMIT_SOON_MS) || (w.usedPercent >= LIMIT_HIGH_PCT && w.usedPercent < 100);
        const pushed = this.limitsSeen.get(key);
        if (pushed === undefined) {
          this.limitsSeen.set(key, pressing);
          continue;
        }
        if (pushed || !pressing) continue;
        this.limitsSeen.set(key, true);
        if (wanted) out.push(limitPush(l, w, now));
      }
    }
    if (this.limitsSeen.size > 64) for (const k of [...this.limitsSeen.keys()].slice(0, this.limitsSeen.size - 64)) this.limitsSeen.delete(k);
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

/** Silent updates pause while fewer messages than this are left for the day, so alerts still get through. */
export const QUIET_RESERVE = 50;

/**
 * How many messages this sender may still publish today, when the server limits them
 * (ntfy.sh: 250 a day per network address, counted by the server across every sender);
 * undefined when it does not say.
 */
export async function messagesLeft(cfg: PhoneConfig, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetchImpl(`${cfg.server}/v1/account`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return undefined;
  const a = (await res.json().catch(() => undefined)) as { limits?: { messages?: number }; stats?: { messages_remaining?: number } } | undefined;
  const limit = a?.limits?.messages;
  const left = a?.stats?.messages_remaining;
  return typeof limit === 'number' && limit > 0 && typeof left === 'number' ? left : undefined;
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
  /** Messages left for today (default: asks the ntfy server). */
  budget?: (cfg: PhoneConfig) => Promise<number | undefined>;
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
  private left: number | undefined;
  private leftAt = -Infinity;
  private quietPaused = false;
  private readonly planner: PushPlanner;
  private readonly sender = new PushSender();
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
    const send = this.opts.send ?? ((c: PhoneConfig, p: PhonePush) => this.sender.send(c, p));
    for (const p of pushes) {
      if (p.priority <= 2 && !(await this.quietAllowed(cfg))) continue;
      const r = await send(cfg, p);
      if (r.ok && this.left !== undefined) this.left -= 1;
      this.opts.report?.(r.ok ? p.title : `${p.title}: ${r.error}`, r.ok);
    }
  }

  /** Silent updates are worth a message only while the day's ntfy allowance keeps room for alerts. */
  private async quietAllowed(cfg: PhoneConfig): Promise<boolean> {
    if (!cfg.topic) return true;
    const now = Date.now();
    if (now - this.leftAt >= 60_000) {
      this.leftAt = now;
      this.left = await (this.opts.budget ?? messagesLeft)(cfg).catch(() => undefined);
    }
    const ok = this.left === undefined || this.left > QUIET_RESERVE;
    if (ok === this.quietPaused) {
      this.quietPaused = !ok;
      this.opts.report?.(
        ok ? 'progress updates resumed' : `progress updates paused: ${this.left} notifications left today on ${new URL(cfg.server).host}, kept for alerts`,
        ok,
      );
    }
    return ok;
  }
}
