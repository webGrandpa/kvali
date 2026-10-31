/**
 * kvali — terminal dashboard for AI coding agents.
 *
 *   kvali                      live dashboard (q or Ctrl+C to quit)
 *   kvali --once               print the dashboard once
 *   kvali --json               print one snapshot as JSON
 *   kvali hooks install|uninstall|status    manage Claude Code hooks
 *   kvali protocol [dir]       add the progress protocol to <dir>/AGENTS.md
 *   kvali phone                notifications on your phone (ntfy)
 *   kvali watch                no dashboard: hooks and phone notifications only
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  DEFAULT_HOOK_PORT,
  Engine,
  GeminiCliAdapter,
  HookHub,
  ProgressFileAdapter,
  STATUS_LABEL,
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
  fmtAgo,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  groupByProject,
  installClaudeHooks,
  kvaliConfigFile,
  newPhoneConfig,
  PushPlanner,
  qrTerminal,
  readPhoneConfig,
  sendPush,
  subscribeLink,
  testPush,
  writePhoneConfig,
  pathWithin,
  progressOf,
  sessionTokens,
  todayUsage,
  uninstallClaudeHooks,
  type AgentSession,
  type PhoneConfig,
  type Snapshot,
} from '@kvali/core';

const VERSION = '0.5.1';

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
  steps: boolean;
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
    steps: false,
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
      case '--window':
        opts.windowHours = Number(next());
        break;
      case '--home':
        opts.home = path.resolve(next());
        break;
      case '--brain-dir':
        opts.brainDirs.push(path.resolve(next()));
        break;
      case '--port':
        opts.port = Number(next());
        break;
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
  kvali watch                 run without a dashboard: hooks and phone notifications (e.g. in the background)

Options
  -p, --project <dir>         only sessions inside <dir>      --here   same, for the current directory
  --window <hours>            how far back to look (default 24)
  --brain-dir <dir>           extra Antigravity brain directory (repeatable)
  --home <dir>                read agent data from another home directory
  --port <n>                  hook hub port (default ${DEFAULT_HOOK_PORT})
  --no-hub                    do not listen for hook events (and send no phone notifications)
  --no-color
  kvali phone options: --server <url> (self-hosted ntfy)  --token <token>  --private (no project or step names)  --steps (also each finished step)`;

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

  const limits = new Map<string, AgentSession>();
  for (const s of sessions) if (s.rateLimits?.length && !limits.has(s.agent)) limits.set(s.agent, s);
  for (const s of limits.values()) {
    const parts = s.rateLimits!.map((r) => {
      const pct = Math.round(r.usedPercent);
      const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
      const reset = r.resetsAt ? c.gray(` resets in ${fmtDuration(r.resetsAt - now)}`) : '';
      return `${r.label} ${color(`${pct}%`)}${reset}`;
    });
    lines.push(`${c.gray('limits')}  ${agentTag(s, c).trim()}  ${parts.join(c.gray('  ·  '))}`);
  }

  if (sessions.length === 0) {
    lines.push('', c.gray(`No agent sessions in the last ${opts.windowHours}h${opts.project ? ` under ${opts.project}` : ''}.`));
    lines.push(c.gray('Start Claude Code, Codex, Gemini CLI or Antigravity and sessions appear here automatically.'));
    lines.push(c.gray('Other agents (Cursor, Copilot, …): run `kvali protocol` in your repo to add the AGENTS.md progress protocol.'));
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
    adapters: [
      new ClaudeCodeAdapter(),
      new CodexAdapter(),
      new GeminiCliAdapter(),
      new AntigravityAdapter(opts.brainDirs),
      new ProgressFileAdapter(),
    ],
  });
}

async function hooks(sub: string | undefined, opts: Options): Promise<void> {
  const file = claudeSettingsPath(opts.home);
  if (sub === 'install') {
    const { backup } = await installClaudeHooks(file, opts.port);
    console.log(`Installed Kvali hooks in ${file}${backup ? ` (backup: ${backup})` : ''}.`);
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
 * open too each event still reaches the phone once.
 */
function startPhone(engine: Engine, hub: HookHub | undefined, home: string, report: (line: string) => void): void {
  const planner = new PushPlanner();
  let cfg: PhoneConfig | undefined;
  let mtime = -1;
  let checked = 0;
  engine.onSnapshot((snap) => {
    void (async () => {
      const now = Date.now();
      if (now - checked >= 5_000) {
        checked = now;
        const m = (await fsp.stat(kvaliConfigFile(home)).catch(() => undefined))?.mtimeMs ?? 0;
        if (m !== mtime) {
          mtime = m;
          cfg = await readPhoneConfig(home);
        }
      }
      if (!cfg) return;
      const pushes = planner.observe(snap, cfg);
      if (!pushes.length || !hub?.isHub) return;
      for (const p of pushes) {
        const r = await sendPush(cfg, p);
        report(r.ok ? `phone ← ${p.title}` : `phone: not sent (${r.error})`);
      }
    })();
  });
}

async function phone(sub: string | undefined, opts: Options): Promise<void> {
  const c = paint(opts.color);
  if (sub === 'off') {
    await writePhoneConfig(opts.home, undefined);
    console.log('Phone notifications are off. You can remove the Kvali topic from the ntfy app too.');
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
  if (sub) fail(`unknown phone command "${sub}" (phone, phone test, phone off)`);
  const fresh = !cfg;
  cfg ??= newPhoneConfig(opts.server);
  if (opts.server) cfg.server = opts.server.replace(/\/+$/, '');
  if (opts.token) cfg.token = opts.token;
  if (opts.private) cfg.details = false;
  if (opts.steps && !cfg.events.includes('steps')) cfg.events.push('steps');
  await writePhoneConfig(opts.home, cfg);
  const self = cfg.server !== 'https://ntfy.sh';
  console.log(
    [
      c.bold('Kvali → your phone'),
      '',
      '  1. Install the free ntfy app (iPhone or Android): https://ntfy.sh',
      `  2. Android: scan this code. iPhone: in ntfy tap + and enter the topic${self ? ` (server ${cfg.server})` : ''}.`,
      '',
      qrTerminal(subscribeLink(cfg), opts.color),
      '',
      `  Topic: ${c.bold(cfg.topic)}${fresh ? c.gray('  (new; keep it to yourself: the name is the key)') : ''}`,
      '',
    ].join('\n'),
  );
  const r = await sendPush(cfg, testPush());
  console.log(r.ok ? c.green('  Sent a test notification.') : c.yellow(`  Could not send a test notification: ${r.error}`));
  console.log(
    [
      '',
      '  You get a notification when an agent needs you, finishes a long task, fails or goes quiet.',
      '  They are sent while Kvali runs: the editor extension, `kvali`, or `kvali watch` in the background.',
      "  Kvali's Claude Code plugin sends them for its own sessions by itself.",
      `  ${c.gray('Test: kvali phone test · Stop: kvali phone off')}`,
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const { cmd, opts } = parse(process.argv.slice(2));
  if (cmd[0] === 'hooks') return hooks(cmd[1], opts);
  if (cmd[0] === 'setup') {
    if (cmd[1] === 'off') {
      await removeSetup(opts.home, process.env);
      console.log('Removed Kvali hooks and planning rules.');
      return;
    }
    const d = await detectAgents(opts.home, process.env);
    const changes = setupChanges(d);
    if (!changes.length) fail('no supported agent found (~/.claude, ~/.codex, ~/.gemini)');
    await applySetup(opts.home, process.env, opts.port, d);
    console.log(['Kvali is on:', ...changes.map((c) => `  • ${c}`), 'Undo with `kvali setup off`.'].join('\n'));
    return;
  }
  if (cmd[0] === 'phone') return phone(cmd[1], opts);
  if (cmd[0] === 'watch') return watch(opts);
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
          agent === 'claude-code' ? claudeHookReply(ev, engine.snapshot.sessions.find((x) => x.agent === 'claude-code' && x.id === ev.sessionId)) : undefined,
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
      agent === 'claude-code' ? claudeHookReply(ev, engine.snapshot.sessions.find((x) => x.agent === 'claude-code' && x.id === ev.sessionId)) : undefined,
    onRoleChange: (isHub) => say(isHub ? `listening for agent hooks on 127.0.0.1:${opts.port}` : 'another Kvali (an editor window?) holds the hook port and sends the notifications'),
  });
  const say = (line: string) => console.log(`${new Date().toLocaleTimeString()} ${line}`);
  hub.start();
  startPhone(engine, hub, opts.home, say);
  engine.start();
  const cfg = await readPhoneConfig(opts.home);
  say(cfg ? `watching agents; phone notifications go to ${cfg.topic}` : 'watching agents; phone notifications are not set up (run `kvali phone`)');
  const stop = () => {
    hub.dispose();
    engine.dispose();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
