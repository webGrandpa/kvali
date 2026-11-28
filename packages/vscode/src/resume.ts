/**
 * Resuming and continuing sessions: the command lines Kvali types into a terminal. Ids and model
 * names are checked before they reach a shell, and the only message is Kvali's own.
 */
import type { AgentId } from '@kvali/core';
import { SAFE_ID } from './paths.ts';

/** What Kvali asks Claude when you press Continue on a session a limit stopped. */
export const CONTINUE_PROMPT = 'Continue where you left off. If a command was cut off when you stopped, run it again.';

/** A model name a shell can't read as anything else: "claude-opus-5-5", "claude-fable-5-2[1m]". */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(?:\[1m\])?$/;

/** Models a stopped Claude Code session can go on with, when its own model has a limit of its own. */
export const CONTINUE_MODELS: readonly { id: string; label: string; family: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', family: 'opus' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', family: 'sonnet' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', family: 'fable' },
];

/** The family a model name belongs to ("fable" for "claude-fable-5-2"), if it is a Claude model. */
export function modelFamily(model: string | undefined): string | undefined {
  return /claude-(fable|mythos|opus|sonnet|haiku)/i.exec(model ?? '')?.[1]?.toLowerCase();
}

/** Whether a limit binds one model only ("Fable limit", "Opus limit"), so another model can go on now. */
export function limitOfOneModel(limit: string): boolean {
  return /^(fable|mythos|opus|sonnet|haiku)\b/i.test(limit);
}

export function resumeCommand(agent: AgentId, id: string, opts: { prompt?: string; model?: string } = {}): string | undefined {
  if (!SAFE_ID.test(id)) return undefined;
  if (agent === 'codex') return `codex resume ${id}`;
  if (agent !== 'claude-code') return undefined;
  const parts = ['claude', '--resume', id];
  // Quoted: zsh reads [1m] as a pattern.
  if (opts.model && MODEL.test(opts.model)) parts.push('--model', `"${opts.model}"`);
  // Plain words in double quotes read the same in zsh, bash, fish, PowerShell and cmd.
  if (opts.prompt) parts.push(`"${opts.prompt.replace(/["`$\\!%^&|<>]/g, '')}"`);
  return parts.join(' ');
}
