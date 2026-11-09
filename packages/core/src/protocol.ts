import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { trimLeadingNewlines, trimTrailingNewlines, writeFileSafely } from './util/files.ts';

export const PROGRESS_PROTOCOL_MARKER = '<!-- kvali:progress-protocol v2 -->';

/** The AGENTS.md section that asks any agent to keep its plan visible. */
export function progressProtocolSnippet(): string {
  return `${PROGRESS_PROTOCOL_MARKER}
## Progress reporting

For any task that takes more than two steps, keep your plan visible so the user can follow progress without asking:

- If you have a built-in plan or todo tool (Claude Code Tasks/TodoWrite, Codex \`update_plan\`, Gemini CLI \`write_todos\`, Antigravity \`task.md\`), create the plan with it before you start, update it as you go, and do not create \`.agents/progress.md\`.
- Only agents without such a tool maintain \`.agents/progress.md\`, in this format:

  \`\`\`md
  ---
  agent: <your name, e.g. Cursor>
  status: working   # working | waiting | done | error
  ---
  # <short task title>
  - [x] a finished step
  - [/] the step you are working on now
  - [ ] a next step
  \`\`\`

- Keep exactly one step marked \`[/]\`. Update the file right after each step, set \`status: waiting\` when you need input from the user, and \`status: done\` when everything is finished.
<!-- /kvali:progress-protocol -->
`;
}

export const PLAN_RULE_MARKER = '<!-- kvali:plan-rule v2 -->';

/** A short global instruction for agents that have a built-in plan tool. */
export function planRuleSnippet(): string {
  return `${PLAN_RULE_MARKER}
## Keep a visible plan

For any task that takes more than two steps, create a task list with your built-in plan tool before you start (Claude Code: TaskCreate/TaskUpdate or TodoWrite, whichever it has, loaded with ToolSearch when not in your tool list; Codex: update_plan; Gemini CLI: write_todos; Antigravity: task.md), keep exactly one item in progress, and mark each item done as soon as it is finished. The user follows your progress from this list.
<!-- /kvali:plan-rule -->
`;
}

export type WriteResult = 'added' | 'created' | 'updated' | 'exists';

/**
 * Where Kvali's block of this kind is: its opening and closing comments, each on a line of its
 * own and outside fenced code (a README that shows the markers in an example is not a block).
 * `end` is missing when the opening is there but its closing comment was removed.
 */
export function findBlock(text: string, name: string): { start: number; end?: number } | undefined {
  const open = new RegExp(`^<!-- kvali:${name} v\\d+ -->$`);
  const close = `<!-- /kvali:${name} -->`;
  let fence: { ch: string; len: number } | undefined;
  let start: number | undefined;
  let pos = 0;
  for (const raw of text.split('\n')) {
    const at = pos;
    pos += raw.length + 1;
    const line = (raw.endsWith('\r') ? raw.slice(0, -1) : raw).trimEnd();
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (!fence) fence = { ch: mark[0]!, len: mark.length };
      else if (mark[0] === fence.ch && mark.length >= fence.len && f[2]!.trim() === '') fence = undefined;
      continue;
    }
    if (fence) continue;
    if (start === undefined) {
      if (open.test(line)) start = at;
    } else if (line === close) {
      return { start, end: at + close.length };
    }
  }
  return start === undefined ? undefined : { start };
}

/**
 * Puts Kvali's current `snippet` into `text`: appended when the file has no Kvali block of
 * this kind, replaced in place when an older version of the block is there (any `vN`
 * marker, so wording fixes reach people who added it earlier), left alone when it is
 * current or when its end marker was removed (Kvali never guesses where a block ends).
 */
function withBlock(text: string | undefined, name: string, snippet: string): { text: string; result: WriteResult } {
  if (text === undefined || text === '') return { text: snippet, result: text === undefined ? 'created' : 'added' };
  const found = findBlock(text, name);
  if (found) {
    if (found.end === undefined) return { text, result: 'exists' };
    const crlf = text.includes('\r\n');
    const block = snippet.trimEnd();
    if (text.slice(found.start, found.end).replace(/\r\n/g, '\n') === block) return { text, result: 'exists' };
    return { text: text.slice(0, found.start) + (crlf ? block.replace(/\n/g, '\r\n') : block) + text.slice(found.end), result: 'updated' };
  }
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${sep}${snippet}`, result: 'added' };
}

export type InstructionTarget = 'claude-code' | 'codex' | 'gemini';

/** Global instruction files of agents that support one. Only agents that are installed are touched. */
export function globalInstructionFiles(
  home: string,
  env: Record<string, string | undefined> = {},
): { id: InstructionTarget; agent: string; dir: string; file: string }[] {
  const claude = env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim() || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const gemini = path.join(home, '.gemini');
  return [
    { id: 'claude-code', agent: 'Claude Code', dir: claude, file: path.join(claude, 'CLAUDE.md') },
    { id: 'codex', agent: 'Codex', dir: codex, file: path.join(codex, 'AGENTS.md') },
    { id: 'gemini', agent: 'Gemini CLI / Antigravity', dir: gemini, file: path.join(gemini, 'GEMINI.md') },
  ];
}

/** `text` without Kvali's block of this kind; undefined when there is no whole block to take out. */
export function withoutBlock(text: string, name: string): string | undefined {
  const found = findBlock(text, name);
  // No closing comment: Kvali never guesses where its block ends, so the file stays as it is.
  if (!found || found.end === undefined) return undefined;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const before = trimTrailingNewlines(text.slice(0, found.start));
  const after = trimLeadingNewlines(text.slice(found.end));
  if (!before) return after;
  if (!after) return `${before}${nl}`;
  return `${before}${nl}${nl}${after}`;
}

/**
 * Removes Kvali's plan rule from every global instruction file. A file that held nothing but
 * the rule (Kvali created it) is deleted; everything of yours stays.
 */
export async function removeGlobalPlanRule(home: string, env: Record<string, string | undefined> = {}): Promise<string[]> {
  const changed: string[] = [];
  for (const target of globalInstructionFiles(home, env)) {
    let text: string;
    try {
      text = await fsp.readFile(target.file, 'utf8');
    } catch {
      continue;
    }
    const next = withoutBlock(text, 'plan-rule');
    if (next === undefined) continue;
    if (next.trim() === '') await fsp.unlink(target.file);
    else await writeFileSafely(target.file, next);
    changed.push(target.file);
  }
  return changed;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Adds the plan rule to each installed agent's global instructions, so every new session
 * in every project keeps a plan. A current rule is left alone; an older one is updated in
 * place. `only` limits the agents (Claude Code gets planning through hooks instead).
 */
export async function addGlobalPlanRule(
  home: string,
  env: Record<string, string | undefined> = {},
  only?: readonly InstructionTarget[],
): Promise<{ agent: string; file: string; result: WriteResult }[]> {
  const out: { agent: string; file: string; result: WriteResult }[] = [];
  for (const target of globalInstructionFiles(home, env)) {
    if (only && !only.includes(target.id)) continue;
    try {
      const st = await fsp.stat(target.dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue; // agent not installed
    }
    const next = withBlock(await readOptional(target.file), 'plan-rule', planRuleSnippet());
    if (next.result !== 'exists') await writeFileSafely(target.file, next.text);
    out.push({ agent: target.agent, file: target.file, result: next.result });
  }
  return out;
}

/**
 * Adds the protocol to `<root>/AGENTS.md` (creating it if needed). Returns `exists` when the
 * current section is already there and `updated` when an older version was replaced.
 */
export async function addProgressProtocol(root: string): Promise<{ file: string; result: WriteResult }> {
  const file = path.join(root, 'AGENTS.md');
  const current = await readOptional(file);
  const next = withBlock(current ?? '# AGENTS.md\n\n', 'progress-protocol', progressProtocolSnippet());
  if (next.result !== 'exists') await writeFileSafely(file, next.text);
  return { file, result: current === undefined ? 'created' : next.result };
}
