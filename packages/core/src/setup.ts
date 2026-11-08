/**
 * One-step setup shared by the editor extension and the CLI.
 *
 * "Turn on" means:
 *   - Claude Code: Kvali's plugin (live pane, exact status, alerts, automatic plans), added with
 *     Claude Code's own plugin command; Kvali's hooks only where that Claude Code has no plugins
 *   - Codex: a short planning rule in ~/.codex/AGENTS.md
 *   - Gemini CLI / Antigravity: the same rule in ~/.gemini/GEMINI.md
 * Everything is marked, idempotent and removed again by `removeSetup` (the extension
 * runs it automatically when it is uninstalled).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath, installClaudeHooks, uninstallClaudeHooks } from './hooks/claude-install.ts';
import {
  claudeExtensionDirs,
  claudePluginEnabled,
  findClaudeBinary,
  installClaudePlugin,
  kvaliPluginDir,
  removeClaudePlugin,
  syncClaudePlugin,
  writeKvaliState,
} from './hooks/claude-plugin.ts';
import { DEFAULT_HOOK_PORT } from './hooks/hub.ts';
import { addGlobalPlanRule, removeGlobalPlanRule, type InstructionTarget } from './protocol.ts';

export interface DetectedAgents {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  antigravity: boolean;
}

type Env = Record<string, string | undefined>;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectAgents(home: string, env: Env = {}): Promise<DetectedAgents> {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || path.join(home, '.claude');
  const [claude, codex, gemini, ag1, ag2] = await Promise.all([
    isDir(claudeDir),
    isDir(env.CODEX_HOME || path.join(home, '.codex')),
    isDir(path.join(home, '.gemini')),
    isDir(path.join(home, '.gemini', 'antigravity')),
    isDir(path.join(home, '.gemini', 'antigravity-ide')),
  ]);
  return { claude, codex, gemini, antigravity: ag1 || ag2 };
}

export function detectedLabels(d: DetectedAgents): string[] {
  return [d.claude && 'Claude Code', d.codex && 'Codex', d.gemini && !d.antigravity && 'Gemini CLI', d.antigravity && 'Antigravity'].filter(
    (x): x is string => !!x,
  );
}

/** Human-readable list of what `applySetup` changes, for consent screens. */
export function setupChanges(d: DetectedAgents): string[] {
  const out: string[] = [];
  if (d.claude) out.push("Claude Code: the Kvali plugin (live progress pane, exact status, alerts, automatic plans), added with Claude Code's own plugin command");
  if (d.codex) out.push('Codex: a planning rule in ~/.codex/AGENTS.md');
  if (d.gemini) out.push(`${d.antigravity ? 'Antigravity / Gemini CLI' : 'Gemini CLI'}: a planning rule in ~/.gemini/GEMINI.md`);
  return out;
}

export interface SetupOptions {
  /** The Claude Code plugin folder that ships with this Kvali. Without it Claude Code gets hooks. */
  pluginDir?: string;
  /** Claude Code editor extension folders the editor knows (its `claude` command lives inside). */
  claudeExtensionDirs?: readonly string[];
}

export interface SetupResult {
  /** How Claude Code is connected. */
  claude?: 'plugin' | 'hooks';
  /** Why Claude Code got hooks instead of the plugin. */
  claudeNote?: string;
}

async function setupClaudePlugin(home: string, env: Env, opts: SetupOptions): Promise<{ ok: boolean; note?: string }> {
  try {
    await syncClaudePlugin(opts.pluginDir!, home);
    // Already enabled: Claude Code reads the folder in place, so the sync above was the update.
    if (await claudePluginEnabled(claudeSettingsPath(home, env))) return { ok: true };
    const bin = await findClaudeBinary({ home, env, extensionDirs: [...(opts.claudeExtensionDirs ?? []), ...(await claudeExtensionDirs(home))] });
    if (!bin) return { ok: false, note: "Claude Code's command was not found" };
    const r = await installClaudePlugin(bin, kvaliPluginDir(home), env);
    if (!r.ok) return { ok: false, note: r.error };
    await writeKvaliState(home, { claudePlugin: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, note: (err as Error).message };
  }
}

export async function applySetup(home: string, env: Env = {}, port = DEFAULT_HOOK_PORT, d?: DetectedAgents, opts: SetupOptions = {}): Promise<SetupResult> {
  const agents = d ?? (await detectAgents(home, env));
  const result: SetupResult = {};
  if (agents.claude) {
    const settings = claudeSettingsPath(home, env);
    const plugin = opts.pluginDir ? await setupClaudePlugin(home, env, opts) : { ok: false, note: undefined };
    if (plugin.ok) {
      // Kvali's hooks stay beside the plugin: a Claude Code that cannot load the plugin (an older
      // one in another editor, which reads the same settings) still reports through them and gets
      // the plan request. Where the plugin runs, Kvali hears only the plugin: the hub's reply and
      // the session's status give way to it, so nothing is reported twice.
      await installClaudeHooks(settings, port);
      result.claude = 'plugin';
    } else {
      await installClaudeHooks(settings, port);
      result.claude = 'hooks';
      result.claudeNote = plugin.note;
    }
  }
  const only: InstructionTarget[] = [];
  if (agents.codex) only.push('codex');
  if (agents.gemini) only.push('gemini');
  if (only.length) await addGlobalPlanRule(home, env, only);
  return result;
}

export async function removeSetup(home: string, env: Env = {}, opts: Pick<SetupOptions, 'claudeExtensionDirs'> = {}): Promise<void> {
  const settings = claudeSettingsPath(home, env);
  const bin = await findClaudeBinary({ home, env, extensionDirs: [...(opts.claudeExtensionDirs ?? []), ...(await claudeExtensionDirs(home))] }).catch(() => undefined);
  await removeClaudePlugin({ home, env, settingsFile: settings, bin }).catch(() => undefined);
  await uninstallClaudeHooks(settings).catch(() => undefined);
  await removeGlobalPlanRule(home, env).catch(() => undefined);
}
