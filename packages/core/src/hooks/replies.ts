/**
 * What the hook hub answers to a synchronous hook.
 *
 * Today one reply exists: when a Claude Code prompt arrives and the session has no
 * unfinished plan, ask Claude to keep a task list. The text costs ~60 tokens, is only
 * sent while there is no plan, and never contains anything from the user's prompt.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentSession } from '../model.ts';
import { progressOf } from '../model.ts';
import type { LiveEvent } from './hub.ts';

export const CLAUDE_PLAN_CONTEXT =
  'Progress tracking (Kvali): if this request takes more than two steps, start by creating a task list with TaskCreate ' +
  'or TodoWrite, whichever you have (if neither is in your tool list, look for them once with ToolSearch, and go on ' +
  'without a list if they are not there), keep exactly ' +
  'one task in_progress, and mark each task completed as soon as it is done. ' +
  'The user follows your progress from that list, so keep it current.';

/** Whether Kvali's Claude Code plugin runs in a session: it writes a heartbeat file from its first moment. */
export function pluginRunsIn(liveDir: string, sessionId: string): boolean {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return false;
  return existsSync(path.join(liveDir, 'claude-code', `${sessionId}.mod.json`));
}

export function claudeHookReply(ev: LiveEvent, session: AgentSession | undefined, pluginRuns = false): object | undefined {
  if (ev.event !== 'UserPromptSubmit') return undefined;
  if (pluginRuns) return undefined; // the plugin asks for a plan itself
  if (session) {
    const p = progressOf(session.tasks);
    if (p.total > 0 && p.done < p.total) return undefined; // a plan is already running
  }
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CLAUDE_PLAN_CONTEXT } };
}
