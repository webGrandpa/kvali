/**
 * Installs or removes Kvali's Claude Code hooks in a settings.json file.
 *
 * Every hook forwards the event JSON to the local hook hub with curl (bypassing any
 * HTTP proxy, since the hub is on 127.0.0.1) and always exits 0, so it never breaks Claude Code, even when no editor with Kvali is running.
 *
 * - Notification, Stop, SessionEnd run `async`: fire and forget, zero latency.
 * - UserPromptSubmit runs synchronously (1 s cap, usually a few ms) and prints the
 *   hub's reply. When the session has no unfinished plan, the reply asks Claude to
 *   keep a task list, which is what turns into Kvali's progress bar. No CLAUDE.md edits.
 *
 * Only long-established events are used, so older Claude Code versions accept the file.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookStatus } from '../model.ts';
import { writeFileSafely } from '../util/files.ts';
import { readKvaliState, writeKvaliState } from './claude-plugin.ts';
import { DEFAULT_HOOK_PORT } from './hub.ts';

interface HookSpec {
  event: string;
  /** Sync hooks print the hub's reply so Claude Code can read it; async hooks discard output. */
  sync: boolean;
}

export const CLAUDE_HOOKS: readonly HookSpec[] = [
  { event: 'UserPromptSubmit', sync: true },
  { event: 'Notification', sync: false },
  { event: 'Stop', sync: false },
  { event: 'SessionEnd', sync: false },
];
export const CLAUDE_HOOK_EVENTS = CLAUDE_HOOKS.map((h) => h.event);
const MARKER = '/v1/events/claude-code';

export function claudeSettingsPath(home = os.homedir(), env: Record<string, string | undefined> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || path.join(home, '.claude');
  return path.join(dir, 'settings.json');
}

export function claudeHookCommand(port = DEFAULT_HOOK_PORT, sync = false): string {
  const url = `http://127.0.0.1:${port}${MARKER}`;
  return sync
    ? `curl -s --noproxy '*' -m 1 --connect-timeout 0.3 -H 'Content-Type: application/json' --data-binary @- ${url} || true`
    : `curl -s --noproxy '*' -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- ${url} || true`;
}

function hookEntry(spec: HookSpec, port: number): Record<string, unknown> {
  return spec.sync
    ? { type: 'command', command: claudeHookCommand(port, true), timeout: 3 }
    : { type: 'command', command: claudeHookCommand(port, false), async: true, timeout: 5 };
}

type Settings = Record<string, any>;

async function readSettings(file: string): Promise<Settings> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix it first; Kvali will not overwrite it.`);
  }
}

function isKvaliGroup(group: any): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

/** Returns a copy of `settings` without Kvali's hook entries. */
function withoutKvali(settings: Settings): Settings {
  const next: Settings = { ...settings };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks: Settings = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.filter((g) => !isKvaliGroup(g));
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** `outdated` means Kvali hooks exist but differ from this version's layout (e.g. after an update or port change). */
export async function claudeHooksStatus(file = claudeSettingsPath(), port = DEFAULT_HOOK_PORT): Promise<HookStatus> {
  let settings: Settings;
  try {
    settings = await readSettings(file);
  } catch {
    return 'not-installed';
  }
  let found = 0;
  let current = 0;
  let total = 0;
  for (const groups of Object.values(settings.hooks ?? {})) if (Array.isArray(groups)) total += groups.filter(isKvaliGroup).length;
  for (const spec of CLAUDE_HOOKS) {
    const groups = settings.hooks?.[spec.event];
    if (!Array.isArray(groups)) continue;
    const g = groups.find(isKvaliGroup);
    if (!g) continue;
    found += 1;
    const want = hookEntry(spec, port);
    if (g.hooks.some((h: any) => h.command === want.command && (h.async === true) === (want.async === true))) current += 1;
  }
  if (found === 0 && total === 0) return 'not-installed';
  return current === CLAUDE_HOOKS.length && total === CLAUDE_HOOKS.length ? 'installed' : 'outdated';
}

async function writeWithBackup(file: string, before: string | undefined, settings: Settings): Promise<string | undefined> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (before !== undefined) {
    // The settings can hold API keys in `env`: the copy is for its owner only.
    backup = `${file}.kvali-backup`;
    await writeFileSafely(backup, before, 0o600);
  }
  // Never half written (Claude Code would not start); a symlinked settings.json, e.g. from a dotfiles repo, stays a symlink.
  await writeFileSafely(file, JSON.stringify(settings, null, 2) + '\n');
  return backup;
}

/** The same settings whatever the order of their keys (Claude Code reads them by name). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
}

/** Adds Kvali's hooks, or brings them up to date. A file that already has them as they should be is left untouched. */
export async function installClaudeHooks(file = claudeSettingsPath(), port = DEFAULT_HOOK_PORT): Promise<{ backup?: string; changed: boolean }> {
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  const current = await readSettings(file);
  const settings = withoutKvali(current);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const spec of CLAUDE_HOOKS) {
    const groups = Array.isArray(settings.hooks[spec.event]) ? settings.hooks[spec.event] : [];
    settings.hooks[spec.event] = [...groups, { hooks: [hookEntry(spec, port)] }];
  }
  // Each editor window with Kvali runs this as it starts: writing a file that needs no change
  // would only race Claude Code's own writes to it.
  if (before !== undefined && canonical(settings) === canonical(current)) return { changed: false };
  return { backup: await writeWithBackup(file, before, settings), changed: true };
}

/**
 * Claude Code gives its task-list tools (TaskCreate, TaskUpdate…) to current models only when
 * this variable is set. Without them Claude cannot keep a plan, and a plan is what becomes
 * Kvali's progress bar.
 */
export const CLAUDE_TODO_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

function envOf(settings: Settings): Record<string, unknown> | undefined {
  return settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : undefined;
}

/**
 * Turns on Claude Code's task-list tools in its settings (`env`), for sessions started from now
 * on. A value the person set themselves, on or off, is left as it is.
 */
export async function enableClaudeTodoTools(file: string, home: string): Promise<{ changed: boolean }> {
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  const settings = await readSettings(file);
  const env = envOf(settings);
  if (env && CLAUDE_TODO_TOOLS_ENV in env) return { changed: false };
  settings.env = { ...(env ?? {}), [CLAUDE_TODO_TOOLS_ENV]: '1' };
  await writeWithBackup(file, before, settings);
  await writeKvaliState(home, { claudeTodoTools: true });
  return { changed: true };
}

/** Takes back the task-list switch, only when Kvali put it there and it is still as Kvali left it. */
export async function disableClaudeTodoTools(file: string, home: string): Promise<{ changed: boolean }> {
  if (!(await readKvaliState(home)).claudeTodoTools) return { changed: false };
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  let changed = false;
  if (before !== undefined) {
    const settings = await readSettings(file);
    const env = envOf(settings);
    if (env?.[CLAUDE_TODO_TOOLS_ENV] === '1') {
      const { [CLAUDE_TODO_TOOLS_ENV]: _gone, ...rest } = env;
      if (Object.keys(rest).length) settings.env = rest;
      else delete settings.env;
      await writeWithBackup(file, before, settings);
      changed = true;
    }
  }
  await writeKvaliState(home, { claudeTodoTools: false });
  return { changed };
}

export async function uninstallClaudeHooks(file = claudeSettingsPath()): Promise<{ backup?: string; changed: boolean }> {
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  if (before === undefined) return { changed: false };
  const settings = await readSettings(file);
  const next = withoutKvali(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
  return { backup: await writeWithBackup(file, before, next), changed: true };
}
