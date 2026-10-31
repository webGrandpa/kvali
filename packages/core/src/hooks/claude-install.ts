/**
 * Installs or removes Kvali's Claude Code hooks in a settings.json file.
 *
 * Each hook is an async command hook that forwards the event JSON to the local
 * hook hub with curl and always exits 0, so it never blocks or breaks Claude Code,
 * even when no editor with Kvali is running.
 *
 * Only long-established events are used, so older Claude Code versions accept the file.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookStatus } from '../model.ts';
import { DEFAULT_HOOK_PORT } from './hub.ts';

export const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;
const MARKER = '/v1/events/claude-code';

export function claudeSettingsPath(home = os.homedir(), env: Record<string, string | undefined> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || path.join(home, '.claude');
  return path.join(dir, 'settings.json');
}

export function claudeHookCommand(port = DEFAULT_HOOK_PORT): string {
  return `curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}${MARKER} || true`;
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

export async function claudeHooksStatus(file = claudeSettingsPath(), port = DEFAULT_HOOK_PORT): Promise<HookStatus> {
  let settings: Settings;
  try {
    settings = await readSettings(file);
  } catch {
    return 'not-installed';
  }
  const cmd = claudeHookCommand(port);
  let found = 0;
  let current = 0;
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    const g = groups.find(isKvaliGroup);
    if (!g) continue;
    found += 1;
    if (g.hooks.some((h: any) => h.command === cmd && h.async === true)) current += 1;
  }
  if (found === 0) return 'not-installed';
  return current === CLAUDE_HOOK_EVENTS.length ? 'installed' : 'outdated';
}

async function writeWithBackup(file: string, before: string | undefined, settings: Settings): Promise<string | undefined> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (before !== undefined) {
    backup = `${file}.kvali-backup`;
    await fsp.writeFile(backup, before);
  }
  // Write in place (not temp + rename) so a symlinked settings.json, e.g. from a dotfiles repo, stays a symlink.
  await fsp.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  return backup;
}

export async function installClaudeHooks(file = claudeSettingsPath(), port = DEFAULT_HOOK_PORT): Promise<{ backup?: string }> {
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  const settings = withoutKvali(await readSettings(file));
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const entry = { hooks: [{ type: 'command', command: claudeHookCommand(port), async: true, timeout: 5 }] };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...groups, structuredClone(entry)];
  }
  return { backup: await writeWithBackup(file, before, settings) };
}

export async function uninstallClaudeHooks(file = claudeSettingsPath()): Promise<{ backup?: string; changed: boolean }> {
  const before = await fsp.readFile(file, 'utf8').catch(() => undefined);
  if (before === undefined) return { changed: false };
  const settings = await readSettings(file);
  const next = withoutKvali(settings);
  if (JSON.stringify(next) === JSON.stringify(settings)) return { changed: false };
  return { backup: await writeWithBackup(file, before, next), changed: true };
}
