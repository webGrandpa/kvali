/**
 * One-step setup shared by the editor extension and the CLI.
 *
 * "Turn on" means:
 *   - Claude Code: Kvali's hooks (alerts + automatic planning context), see hooks/claude-install.ts
 *   - Codex: a short planning rule in ~/.codex/AGENTS.md
 *   - Gemini CLI / Antigravity: the same rule in ~/.gemini/GEMINI.md
 * Everything is marked, idempotent and removed again by `removeSetup` (the extension
 * runs it automatically when it is uninstalled).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { claudeSettingsPath, installClaudeHooks, uninstallClaudeHooks } from './hooks/claude-install.ts';
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
  if (d.claude) out.push('Claude Code: alerts and automatic plans through 4 hooks in ~/.claude/settings.json');
  if (d.codex) out.push('Codex: a planning rule in ~/.codex/AGENTS.md');
  if (d.gemini) out.push(`${d.antigravity ? 'Antigravity / Gemini CLI' : 'Gemini CLI'}: a planning rule in ~/.gemini/GEMINI.md`);
  return out;
}

export async function applySetup(home: string, env: Env = {}, port = DEFAULT_HOOK_PORT, d?: DetectedAgents): Promise<void> {
  const agents = d ?? (await detectAgents(home, env));
  if (agents.claude) await installClaudeHooks(claudeSettingsPath(home, env), port);
  const only: InstructionTarget[] = [];
  if (agents.codex) only.push('codex');
  if (agents.gemini) only.push('gemini');
  if (only.length) await addGlobalPlanRule(home, env, only);
}

export async function removeSetup(home: string, env: Env = {}): Promise<void> {
  await uninstallClaudeHooks(claudeSettingsPath(home, env)).catch(() => undefined);
  await removeGlobalPlanRule(home, env).catch(() => undefined);
}
