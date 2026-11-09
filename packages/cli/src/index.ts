/**
 * kvali — terminal dashboard for AI coding agents.
 *
 *   kvali                      live dashboard (q or Ctrl+C to quit)
 *   kvali --once               print the dashboard once
 *   kvali --json               print one snapshot as JSON
 *   kvali hooks install|uninstall|status    manage Claude Code hooks
 *   kvali protocol [dir]       add the progress protocol to <dir>/AGENTS.md
 *   kvali phone                notifications on your phone (ntfy, Telegram, Discord)
 *   kvali watch                no dashboard: hooks and phone notifications only
 *   kvali week                 the last seven days, to share
 */
import { lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HOOK_PORT,
  Engine,
  HookHub,
  STATUS_LABEL,
  createDefaultAdapters,
  addGlobalPlanRule,
  addProgressProtocol,
  applySetup,
  claudeHookReply,
  detectAgents,
  removeSetup,
  setupChanges,
  claudeHooksStatus,
  claudeSettingsPath,
  currentTask,
  defaultLiveDir,
  fmtAbout,
  fmtAgo,
  fmtDuration,
  fmtEta,
  fmtTokens,
  fmtUsd,
  groupByProject,
  installClaudeHooks,
  newPhoneConfig,
  newTopic,
  PhoneNotifier,
  telegramBot,
  telegramFindChat,
  telegramPairCode,
  telegramStartLink,
  discordCheck,
  channelNames,
  DEFAULT_NTFY_SERVER,
  DEFAULT_PHONE_EVENTS,
  qrTerminal,
  readPhoneConfig,
  sendPush,
  subscribeLink,
  testPush,
  writePhoneConfig,
  pathWithin,
  planEta,
  pluginRunsIn,
  weekSnapshot,
  weekStats,
  weekRange,
  weekShareText,
  weekSvg,
  weekdayShort,
  fmtWork,
  progressOf,
  sessionTokens,
  todayUsage,
  uninstallClaudeHooks,
  DEFAULT_DONE_AFTER_SEC,
  PHONE_EVENTS,
  type AgentSession,
  type PhoneConfig,
  type PhoneEvent,
  type Snapshot,
  secureKvaliHome,
} from '@kvali/core';

const VERSION = '0.7.2';

interface Options {
  json: boolean;
  once: boolean;
  project?: string;
  windowHours: number;
  home: string;
  brainDirs: string[];
  hub: boolean;
  port: number;
  color: boolean;
  server?: string;
  token?: string;
  private: boolean;
  /** `--steps` / `--no-steps`: progress notifications on or off; unset keeps the setup's choice. */
  steps: boolean | undefined;
  /** `--events a,b,c`: exactly these notifications. */
  events: PhoneEvent[] | undefined;
  /** `--done-after <seconds>`: the shortest task whose end is worth a notification. */
  doneAfter: number | undefined;
  /** `kvali week --svg [file]`: also write the card ('' for the default name). */
  svg?: string;
}

function parse(argv: string[]): { cmd: string[]; opts: Options } {
  const opts: Options = {
    json: false,
    once: false,
    windowHours: 24,
    home: os.homedir(),
    brainDirs: [],
    hub: true,
    port: DEFAULT_HOOK_PORT,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
    private: false,
    steps: undefined,
    events: undefined,
    doneAfter: undefined,
  };
  const cmd: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--json':
        opts.json = true;
        break;
      case '--once':
        opts.once = true;
        break;
      case '--project':
      case '-p':
        opts.project = path.resolve(next());
        break;
      case '--here':
        opts.project = process.cwd();
        break;
      case '--window': {
        const hours = Number(next());
        if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) fail('--window takes a number of hours, e.g. 24');
        opts.windowHours = hours;
        break;
      }
      case '--home':
        opts.home = path.resolve(next());
        break;
      case '--brain-dir':
        opts.brainDirs.push(path.resolve(next()));
        break;
      case '--port': {
        // It goes into Claude Code's settings as part of the hook command: only a real port.
        const port = Number(next());
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port takes a port number from 1 to 65535');
        opts.port = port;
        break;
      }
      case '--no-hub':
        opts.hub = false;
        break;
      case '--no-color':
        opts.color = false;
        break;
      case '--server':
        opts.server = next();
        if (!/^https?:\/\/[^\s/]/.test(opts.server)) fail('--server needs an http(s) URL');
        break;
      case '--token':
        opts.token = next();
        break;
      case '--private':
        opts.private = true;
        break;
      case '--steps':
        opts.steps = true;
        break;
      case '--no-steps':
        opts.steps = false;
        break;
      case '--events': {
        const list = next().split(',').map((e) => e.trim()).filter(Boolean);
        const bad = list.filter((e) => !PHONE_EVENTS.includes(e as PhoneEvent));
        if (bad.length) fail(`unknown event ${bad.join(', ')}: choose from ${PHONE_EVENTS.join(', ')}`);
        opts.events = PHONE_EVENTS.filter((e) => list.includes(e));
        break;
      }
      case '--done-after': {
        const sec = Number(next());
        if (!Number.isFinite(sec) || sec < 0) fail('--done-after needs a number of seconds (0: every task)');
        opts.doneAfter = Math.round(sec);
        break;
      }
      case '--svg':
        opts.svg = argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-') ? argv[++i] : '';
        break;
      case '--version':
      case '-v':
        console.log(VERSION);
        process.exit(0);
        break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        if (a.startsWith('-')) fail(`unknown option ${a}`);
        cmd.push(a);
    }
  }
  return { cmd, opts };
}

const HELP = `kvali ${VERSION} — progress, tokens and cost of your AI coding agents

Usage
  kvali                       live dashboard (q or Ctrl+C to quit)
  kvali --once                print the dashboard once
  kvali --json                print one snapshot as JSON
  kvali setup                 one-step setup: alerts + automatic plans for every agent found
  kvali setup off             undo it
  kvali hooks install         install only the Claude Code hooks
  kvali hooks uninstall       remove them
  kvali hooks status
  kvali protocol [dir]        add the progress protocol to <dir>/AGENTS.md
  kvali plan-rule             ask every installed agent to always keep a plan (global)
  kvali phone                 notifications on your phone through ntfy: shows a QR code, sends a test
  kvali phone test | off      send a test notification | stop phone notifications
  kvali phone telegram [off]  notifications from a Telegram bot of your own (asks for its token)
  kvali phone discord [off]   notifications in a Discord channel (asks for its webhook URL)
  kvali watch                 run without a dashboard: hooks and phone notifications (e.g. in the background)
  kvali week [--svg [file]]   your agents' last seven days, a post to share them, and the card as SVG

Options
  -p, --project <dir>         only sessions inside <dir>      --here   same, for the current directory
  --window <hours>            how far back to look (default 24)
  --brain-dir <dir>           extra Antigravity brain directory (repeatable)
  --home <dir>                read agent data from another home directory
  --port <n>                  hook hub port (default ${DEFAULT_HOOK_PORT})
  --no-hub                    do not listen for hook events (and send no phone notifications)
  --no-color
  kvali phone options: --server <url> (self-hosted ntfy)  --token <token>  --private (no project or step names)
                              --events needs-you,done,steps,actions,error,stuck,limits (what to hear about)  --done-after <seconds> (shortest task worth a notification; 0: every task)  --no-steps`;

function fail(msg: string): never {
  console.error(`kvali: ${msg}`);
  process.exit(2);
}

// ---------- rendering ----------

const ESC = '\x1b[';
function paint(on: boolean) {
  const wrap = (code: string) => (s: string) => (on ? `${ESC}${code}m${s}${ESC}0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gray: wrap('90'),
    inverse: wrap('7'),
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;
function fit(s: string, width: number): string {
  if (visible(s) <= width) return s + ' '.repeat(width - visible(s));
  let out = '';
  let n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (n >= width - 1) break;
      out += ch;
      n += 1;
    }
  }
  return out + '…' + (s.includes('\x1b[') ? `${ESC}0m` : '');
}

function bar(done: number, active: number, total: number, width: number, c: ReturnType<typeof paint>): string {
  if (total <= 0) return c.gray('·'.repeat(width));
  const d = Math.round((done / total) * width);
  const a = Math.min(width - d, Math.max(active > 0 ? 1 : 0, Math.round((active / total) * width)));
  return c.green('█'.repeat(d)) + c.cyan('▒'.repeat(a)) + c.gray('░'.repeat(width - d - a));
}

function statusTag(s: AgentSession, c: ReturnType<typeof paint>): string {
  const label = STATUS_LABEL[s.status].padEnd(9);
  switch (s.status) {
    case 'working':
      return c.blue(`● ${label}`);
    case 'waiting':
      return c.yellow(c.bold(`▲ ${label}`));
    case 'done':
      return c.green(`✓ ${label}`);
    case 'error':
      return c.red(`✕ ${label}`);
    case 'stale':
      return c.gray(`◌ ${label}`);
    default:
      return c.gray(`○ ${label}`);
  }
}

function agentTag(s: AgentSession, c: ReturnType<typeof paint>): string {
  const colors: Record<string, (x: string) => string> = {
    'claude-code': c.yellow,
    codex: c.magenta,
    'gemini-cli': c.blue,
    antigravity: c.green,
    copilot: c.cyan,
    cline: c.cyan,
    'roo-code': c.magenta,
    'kilo-code': c.yellow,
    opencode: c.green,
  };
  return (colors[s.agent] ?? c.cyan)(s.agentLabel.padEnd(12).slice(0, 12));
}

export function render(snap: Snapshot, opts: Options, width = process.stdout.columns || 100): string {
  const c = paint(opts.color);
  const now = Date.now();
  const roots = opts.project ? [opts.project] : [];
  const sessions = opts.project ? snap.sessions.filter((s) => pathWithin(s.projectPath, opts.project!)) : snap.sessions;
  const lines: string[] = [];
  const today = todayUsage(sessions, now);
  const w = Math.max(60, Math.min(width, 160));

  lines.push(
    `${c.bold('kvali')} ${c.gray(`· ${sessions.length} session${sessions.length === 1 ? '' : 's'} · today ${fmtTokens(today.tokens)} tokens${today.priced ? ` · API value ${fmtUsd(today.costUsd)}` : ''}`)}`,
  );

  for (const l of snap.limits ?? []) {
    const parts = l.windows.map((r) => {
      const pct = Math.round(r.usedPercent);
      const color = pct >= 90 || r.runsOutAt !== undefined ? c.red : pct >= 70 ? c.yellow : c.green;
      const out = r.runsOutAt !== undefined ? c.red(r.runsOutAt <= now ? ' used up' : ` runs out in ${fmtAbout(r.runsOutAt - now)}`) : '';
      const reset = r.resetsAt && r.resetsAt > now ? c.gray(` resets in ${fmtDuration(r.resetsAt - now)}`) : '';
      return `${r.label} ${color(`${pct}%`)}${out}${reset}`;
    });
    const tag = agentTag({ agent: l.agent, agentLabel: l.agentLabel } as AgentSession, c).trim();
    lines.push(`${c.gray('limits')}  ${tag}  ${parts.join(c.gray('  ·  '))}`);
  }

  if (sessions.length === 0) {
    lines.push('', c.gray(`No agent sessions in the last ${opts.windowHours}h${opts.project ? ` under ${opts.project}` : ''}.`));
    lines.push(c.gray('Start Claude Code, Codex, Gemini CLI, Antigravity, Copilot, Cline, Roo Code, Kilo Code or OpenCode and sessions appear here automatically.'));
    lines.push(c.gray('Other agents (Cursor, Windsurf, Aider, …): run `kvali protocol` in your repo to add the AGENTS.md progress protocol.'));
  }

  const barWidth = 14;
  for (const g of groupByProject(sessions, roots, now)) {
    lines.push('');
    const usage = g.today.tokens ? c.gray(`  today ${fmtTokens(g.today.tokens)}${g.today.costUsd ? ` · API value ${fmtUsd(g.today.costUsd)}` : ''}`) : '';
    lines.push(`${c.bold(c.inverse(` ${g.name} `))}${c.gray(g.path ? `  ${g.path.replace(os.homedir(), '~')}` : '')}${usage}`);
    for (const s of g.sessions) {
      const p = progressOf(s.tasks);
      const prog = p.total
        ? `${bar(p.done, p.inProgress, p.total, barWidth, c)} ${String(p.done).padStart(2)}/${p.total} ${String(p.percent).padStart(3)}%`
        : s.status === 'working' && s.turn
          ? `${c.cyan('~'.repeat(barWidth))} ${`${s.turn.steps} steps`.padEnd(9)}`
          : c.gray('no plan'.padEnd(barWidth + 10));
      const head = `${statusTag(s, c)} ${agentTag(s, c)} `;
      const titleWidth = Math.max(10, w - visible(head) - visible(prog) - 2);
      lines.push(`${head}${fit(c.bold(s.title), titleWidth)} ${prog}`);

      const step = currentTask(s.tasks);
      const doing: string[] = [];
      if (s.status === 'waiting' || s.status === 'error') doing.push((s.status === 'waiting' ? c.yellow : c.red)(s.statusDetail ?? STATUS_LABEL[s.status]));
      else if (step) doing.push(`↳ ${step.activeTitle ?? step.title}`);
      const eta = s.status === 'working' ? planEta(s, now) : undefined;
      if (eta !== undefined) doing.push(c.cyan(fmtEta(eta)));
      if (s.loop) doing.push(c.red(`⟳ going in circles: ${s.loop.detail ?? s.loop.label} failed ${s.loop.count}×`));
      if (s.status === 'working' && s.activity) {
        const a = s.activity;
        doing.push(c.gray(`${a.label}${a.detail ? `: ${a.detail}` : ''} · ${fmtDuration(now - a.startedAt)}`));
      } else if (s.status !== 'working' && s.status !== 'waiting' && s.status !== 'error') {
        doing.push(c.gray(`${s.statusDetail ? `${s.statusDetail} · ` : ''}updated ${fmtAgo(s.updatedAt, now)}`));
      }
      const meta: string[] = [];
      const tok = sessionTokens(s);
      if (tok !== undefined) meta.push(`${fmtTokens(tok)} tok`);
      if (s.costUsd !== undefined) meta.push(`API value ${fmtUsd(s.costUsd)}`);
      if (s.context?.window) meta.push(`context ${Math.round((s.context.used / s.context.window) * 100)}%`);
      if (s.activeSubagents) meta.push(`${s.activeSubagents} subagent${s.activeSubagents > 1 ? 's' : ''}`);
      const metaStr = c.gray(meta.join(' · '));
      const indent = '            ';
      const leftWidth = Math.max(10, w - indent.length - visible(metaStr) - 2);
      lines.push(`${indent}${fit(doing.join(c.gray('  ·  ')), leftWidth)} ${metaStr}`);
    }
  }
  for (const e of snap.errors) lines.push(c.red(`! ${e.agent}: ${e.message}`));
  return lines.join('\n');
}

// ---------- commands ----------

function makeEngine(opts: Options): Engine {
  return new Engine({
    home: opts.home,
    activeWindowMs: opts.windowHours * 3_600_000,
    workspaceRoots: opts.project ? [opts.project] : [process.cwd()],
    liveDir: defaultLiveDir(opts.home),
    adapters: createDefaultAdapters({ extraAntigravityBrainDirs: opts.brainDirs }),
  });
}

/** `kvali week`: the last seven days in numbers, a post to share them, and with `--svg` the card. */
async function week(opts: Options, svgFile: string | undefined): Promise<void> {
  const c = paint(opts.color);
  const snap = await weekSnapshot({
    home: opts.home,
    liveDir: defaultLiveDir(opts.home),
    adapters: createDefaultAdapters({ extraAntigravityBrainDirs: opts.brainDirs }),
    workspaceRoots: [process.cwd()],
  });
  const w = weekStats(snap.sessions, Date.now());
  if (opts.json) {
    console.log(JSON.stringify(w, null, 2));
    return;
  }
  const max = Math.max(1, ...w.days.map((d) => d.activeMs));
  console.log(
    [
      `${c.bold('kvali week')} ${c.gray(`· ${weekRange(w)}`)}`,
      '',
      `  ${c.bold(fmtWork(w.activeMs))} of agent work · ${w.tasksDone} tasks done · ${fmtTokens(w.tokens)} tokens${w.priced && w.costUsd ? ` · API value ${fmtUsd(w.costUsd)}` : ''}`,
      `  ${w.sessions} session${w.sessions === 1 ? '' : 's'} in ${w.projects} project${w.projects === 1 ? '' : 's'}${w.agents.length ? ` · ${w.agents.join(', ')}` : ''}`,
      '',
      ...w.days.map((d) => `  ${weekdayShort(d.day)}  ${c.cyan('█'.repeat(Math.round((d.activeMs / max) * 30)) || c.gray('·'))} ${c.gray(d.activeMs ? fmtWork(d.activeMs) : '')}`),
      '',
      c.gray('  To share:'),
      ...weekShareText(w).split('\n').map((l) => `  ${l}`),
    ].join('\n'),
  );
  if (svgFile !== undefined) {
    const file = path.resolve(svgFile || `kvali-week-${w.days[w.days.length - 1]!.day}.svg`);
    // Never through a link: a repository could plant one under the default name to overwrite another file.
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink()) fail(`${file} is a symbolic link; give the card another file name`);
    await writeFile(file, weekSvg(w));
    console.log(`\n  Card: ${file} ${c.gray('(1200×630 SVG; open it in a browser to save as PNG)')}`);
  }
}

async function hooks(sub: string | undefined, opts: Options): Promise<void> {
  const file = claudeSettingsPath(opts.home);
  if (sub === 'install') {
    const { backup, changed } = await installClaudeHooks(file, opts.port);
    console.log(changed ? `Installed Kvali hooks in ${file}${backup ? ` (backup: ${backup})` : ''}.` : `Kvali hooks are already installed in ${file}.`);
    console.log('Keep `kvali` or the Kvali editor extension running to receive events.');
  } else if (sub === 'uninstall') {
    const r = await uninstallClaudeHooks(file);
    console.log(r.changed ? `Removed Kvali hooks from ${file}.` : 'No Kvali hooks found.');
  } else if (sub === 'status' || sub === undefined) {
    console.log(`Claude Code hooks: ${await claudeHooksStatus(file, opts.port)} (${file})`);
  } else fail(`unknown hooks command "${sub}"`);
}

/**
 * Sends phone notifications while this process holds the hook port, so that with an editor
 * open too each event still reaches the phone once. It looks on every snapshot and on its
 * own clock: a finished task changes nothing the engine would publish.
 */
function startPhone(engine: Engine, hub: HookHub | undefined, home: string, report: (line: string) => void): PhoneNotifier {
  const notifier = new PhoneNotifier({
    home,
    snapshot: () => engine.snapshot,
    canSend: () => !!hub?.isHub,
    report: (line, ok) => report(ok ? `phone ← ${line}` : `phone: not sent (${line})`),
  });
  engine.onSnapshot(() => void notifier.tick());
  notifier.start();
  return notifier;
}

/** The chosen notifications, in words. */
function phoneEventsText(cfg: PhoneConfig): string {
  const done = cfg.doneAfterSec ?? DEFAULT_DONE_AFTER_SEC;
  const words: Record<PhoneEvent, string> = {
    'needs-you': 'a question that waited a minute',
    done: done ? `tasks done after ${fmtDuration(done * 1000)} or longer` : 'every task done',
    steps: 'each finished step (silent)',
    actions: 'every action, live (silent)',
    error: 'errors',
    stuck: 'an agent gone silent or going in circles',
    limits: 'a plan limit running out',
  };
  return cfg.events.length ? PHONE_EVENTS.filter((e) => cfg.events.includes(e)).map((e) => words[e]).join(', ') : 'nothing (no event chosen)';
}

/** Asks for a secret on the terminal without echoing it, so it lands in no shell history. */
async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) fail('this step asks for a token: run it in a terminal');
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let text = '';
    const onData = (ch: string) => {
      for (const k of ch) {
        if (k === '\r' || k === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(text.trim());
          return;
        }
        if (k === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (k === '\u007f' || k === '\b') text = text.slice(0, -1);
        else text += k;
      }
    };
    process.stdin.on('data', onData);
  });
}

/** `kvali phone telegram` and `kvali phone discord`: a bot of one's own, or a channel's webhook. */
async function phoneChannel(which: 'telegram' | 'discord', off: boolean, opts: Options): Promise<void> {
  const c = paint(opts.color);
  const cfg = await readPhoneConfig(opts.home);
  if (off) {
    if (!cfg?.[which]) return void console.log(`${which === 'telegram' ? 'Telegram' : 'Discord'} is not set up.`);
    const rest: PhoneConfig = { ...cfg, [which]: undefined };
    await writePhoneConfig(opts.home, rest.topic || rest.telegram || rest.discord ? rest : undefined);
    console.log(which === 'telegram' ? 'Kvali no longer writes to Telegram.' : 'Kvali no longer posts to Discord.');
    return;
  }
  const base: PhoneConfig = cfg ?? { server: DEFAULT_NTFY_SERVER, events: [...DEFAULT_PHONE_EVENTS], details: true, doneAfterSec: DEFAULT_DONE_AFTER_SEC };
  let only: Partial<PhoneConfig>;
  if (which === 'telegram') {
    console.log([c.bold('Kvali → Telegram'), '', '  1. In Telegram, open @BotFather, send /newbot and choose a name.', '  2. Paste the token it gives you (it stays on this computer):'].join('\n'));
    const token = await askSecret('  Token: ');
    const me = await telegramBot(token);
    if (!me.ok) fail(`could not use this bot: ${me.error}`);
    // Anyone can write to a bot: the code tells Kvali which message is yours.
    const code = telegramPairCode();
    console.log(`  3. Open ${telegramStartLink(me.username, code)} and press Start, or send @${me.username} the code ${c.bold(code)}. Waiting up to 3 minutes…`);
    const chat = await telegramFindChat(token, code, 180_000);
    if (!chat) fail(`the code did not reach @${me.username}; run \`kvali phone telegram\` again and send it while Kvali waits`);
    console.log(`  Kvali will write to ${c.bold(chat.name ?? 'this Telegram chat')} through @${me.username}.`);
    only = { telegram: { token, chatId: chat.id, bot: me.username } };
  } else {
    console.log([c.bold('Kvali → Discord'), '', '  In Discord: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL.', '  Paste it here (it stays on this computer):'].join('\n'));
    const webhook = await askSecret('  Webhook URL: ');
    const check = await discordCheck(webhook);
    if (!check.ok) fail(`could not use this webhook: ${check.error}`);
    only = { discord: { webhook } };
  }
  const next = { ...base, ...only };
  await writePhoneConfig(opts.home, next);
  const r = await sendPush({ ...next, topic: undefined, telegram: undefined, discord: undefined, ...only }, testPush());
  console.log(r.ok ? c.green(`  Connected (${channelNames(next)}). Sent a test notification.`) : c.yellow(`  Saved, but the test was not sent: ${r.error}`));
  console.log(c.gray(`  Stop: kvali phone ${which} off`));
}

async function phone(sub: string | undefined, opts: Options, arg?: string): Promise<void> {
  const c = paint(opts.color);
  if (sub === 'telegram' || sub === 'discord') return phoneChannel(sub, arg === 'off', opts);
  if (sub === 'off') {
    await writePhoneConfig(opts.home, undefined);
    console.log('Phone notifications are off (ntfy, Telegram and Discord). You can remove the Kvali topic from the ntfy app too.');
    return;
  }
  let cfg = await readPhoneConfig(opts.home);
  if (sub === 'test') {
    if (!cfg) fail('phone notifications are not set up; run `kvali phone`');
    const r = await sendPush(cfg, testPush());
    console.log(r.ok ? 'Sent a test notification.' : `Could not send: ${r.error}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (sub) fail(`unknown phone command "${sub}" (phone, phone test, phone off, phone telegram, phone discord)`);
  const fresh = !cfg?.topic;
  cfg = cfg ? { ...cfg, topic: cfg.topic ?? newTopic() } : newPhoneConfig(opts.server);
  const topic = cfg.topic!;
  if (opts.server) cfg.server = opts.server.replace(/\/+$/, '');
  if (opts.token) cfg.token = opts.token;
  if (opts.private) cfg.details = false;
  if (opts.events) cfg.events = opts.events;
  if (opts.steps === true && !cfg.events.includes('steps')) cfg.events.push('steps');
  if (opts.steps === false) cfg.events = cfg.events.filter((e) => e !== 'steps');
  if (opts.doneAfter !== undefined) cfg.doneAfterSec = opts.doneAfter;
  await writePhoneConfig(opts.home, cfg);
  const self = cfg.server !== 'https://ntfy.sh';
  console.log(
    [
      c.bold('Kvali → your phone'),
      '',
      '  1. Install the free ntfy app (iPhone or Android): https://ntfy.sh',
      `  2. Android: scan this code. iPhone: in ntfy tap + and enter the topic${self ? ` (server ${cfg.server})` : ''}.`,
      '',
      qrTerminal(subscribeLink({ server: cfg.server, topic }), opts.color),
      '',
      `  Topic: ${c.bold(topic)}${fresh ? c.gray('  (new; keep it to yourself: the name is the key)') : ''}`,
      '',
    ].join('\n'),
  );
  const r = await sendPush(cfg, testPush());
  console.log(r.ok ? c.green('  Sent a test notification.') : c.yellow(`  Could not send a test notification: ${r.error}`));
  console.log(
    [
      '',
      `  You will hear about: ${phoneEventsText(cfg)}.`,
      '  Choose with --events needs-you,done,steps,actions,error,stuck,limits and --done-after <seconds>.',
      '  They are sent while Kvali runs: the editor extension, `kvali`, or `kvali watch` in the background.',
      "  Kvali's Claude Code plugin sends them for its own sessions by itself.",
      `  ${c.gray('Also on Telegram or Discord: kvali phone telegram · kvali phone discord')}`,
      `  ${c.gray('Test: kvali phone test · Stop: kvali phone off')}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { cmd, opts } = parse(process.argv.slice(2));
  await secureKvaliHome(opts.home);
  if (cmd[0] === 'hooks') return hooks(cmd[1], opts);
  if (cmd[0] === 'setup') {
    if (cmd[1] === 'off') {
      await removeSetup(opts.home, process.env);
      console.log("Removed Kvali's Claude Code plugin, hooks and planning rules.");
      return;
    }
    const d = await detectAgents(opts.home, process.env);
    const changes = setupChanges(d);
    if (!changes.length) fail('no supported agent found (~/.claude, ~/.codex, ~/.gemini)');
    // The Claude Code plugin ships next to this file (dist/claude-plugin).
    const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-plugin');
    const r = await applySetup(opts.home, process.env, opts.port, d, { pluginDir });
    const lines = changes.map((c) => `  • ${c}`);
    if (r.claude === 'plugin') lines.push('  Claude Code: new sessions show the Kvali pane; type /reload-plugins in sessions already open.');
    if (r.claude === 'hooks') lines.push(`  Claude Code: connected through hooks instead${r.claudeNote ? ` (${r.claudeNote})` : ''}.`);
    console.log(['Kvali is on:', ...lines, 'Undo with `kvali setup off`.'].join('\n'));
    return;
  }
  if (cmd[0] === 'phone') return phone(cmd[1], opts, cmd[2]);
  if (cmd[0] === 'watch') return watch(opts);
  if (cmd[0] === 'week') return week(opts, opts.svg);
  if (cmd[0] === 'plan-rule') {
    for (const r of await addGlobalPlanRule(opts.home, process.env)) console.log(`${r.agent}: ${r.result} (${r.file})`);
    return;
  }
  if (cmd[0] === 'protocol') {
    const r = await addProgressProtocol(path.resolve(cmd[1] ?? '.'));
    const said = {
      created: `Created ${r.file} with the progress protocol.`,
      added: `Added the progress protocol to ${r.file}.`,
      updated: `Updated the progress protocol in ${r.file} to the current version.`,
      exists: `${r.file} already has the current progress protocol.`,
    };
    console.log(said[r.result]);
    return;
  }
  if (cmd.length) fail(`unknown command "${cmd[0]}" (see --help)`);

  const engine = makeEngine(opts);
  if (opts.json || opts.once || !process.stdout.isTTY) {
    const snap = await engine.tick();
    process.stdout.write(opts.json ? JSON.stringify(snap, null, 2) + '\n' : render(snap, opts) + '\n');
    return;
  }

  const hub = opts.hub
    ? new HookHub({
        port: opts.port,
        liveDir: defaultLiveDir(opts.home),
        respond: (agent, ev) =>
          agent === 'claude-code'
          ? claudeHookReply(ev, engine.snapshot.sessions.find((x) => x.agent === 'claude-code' && x.id === ev.sessionId), pluginRunsIn(defaultLiveDir(opts.home), ev.sessionId))
          : undefined,
      })
    : undefined;
  hub?.start();
  let phoneLine = '';
  startPhone(engine, hub, opts.home, (line) => {
    phoneLine = `${new Date().toLocaleTimeString()} ${line}`;
  });
  const out = process.stdout;
  out.write(`${ESC}?1049h${ESC}?25l`);
  const restore = () => {
    out.write(`${ESC}?25h${ESC}?1049l`);
    hub?.dispose();
    engine.dispose();
  };
  const draw = (snap: Snapshot) =>
    out.write(`${ESC}H${ESC}2J${render(snap, opts)}\n${paint(opts.color).gray(`\n${phoneLine ? `${phoneLine}\n` : ''}q to quit`)}`);
  engine.onSnapshot(draw);
  engine.start();
  const clock = setInterval(() => draw(engine.snapshot), 1_000);
  const quit = () => {
    clearInterval(clock);
    restore();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  out.on('resize', () => draw(engine.snapshot));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      const k = d.toString();
      if (k === 'q' || k === '\u0003') quit();
    });
  }
}

/** No dashboard: receives agent hooks and sends phone notifications until stopped. */
async function watch(opts: Options): Promise<void> {
  const engine = makeEngine(opts);
  const hub = new HookHub({
    port: opts.port,
    liveDir: defaultLiveDir(opts.home),
    respond: (agent, ev) =>
      agent === 'claude-code'
          ? claudeHookReply(ev, engine.snapshot.sessions.find((x) => x.agent === 'claude-code' && x.id === ev.sessionId), pluginRunsIn(defaultLiveDir(opts.home), ev.sessionId))
          : undefined,
    onRoleChange: (isHub) => say(isHub ? `listening for agent hooks on 127.0.0.1:${opts.port}` : 'another Kvali (an editor window?) holds the hook port and sends the notifications'),
  });
  const say = (line: string) => console.log(`${new Date().toLocaleTimeString()} ${line}`);
  hub.start();
  startPhone(engine, hub, opts.home, say);
  engine.start();
  const cfg = await readPhoneConfig(opts.home);
  say(cfg ? `watching agents; phone notifications go to ${channelNames(cfg)}` : 'watching agents; phone notifications are not set up (run `kvali phone`)');
  const stop = () => {
    hub.dispose();
    engine.dispose();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
