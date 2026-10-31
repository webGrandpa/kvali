import { promises as fsp } from 'node:fs';
import path from 'node:path';

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

export const PLAN_RULE_MARKER = '<!-- kvali:plan-rule v1 -->';

/** A short global instruction for agents that have a built-in plan tool. */
export function planRuleSnippet(): string {
  return `${PLAN_RULE_MARKER}
## Keep a visible plan

For any task that takes more than two steps, create a task list with your built-in plan tool before you start (Claude Code: TaskCreate/TaskUpdate or TodoWrite; Codex: update_plan; Gemini CLI: write_todos; Antigravity: task.md), keep exactly one item in progress, and mark each item done as soon as it is finished. The user follows your progress from this list.
<!-- /kvali:plan-rule -->
`;
}

export type WriteResult = 'added' | 'created' | 'updated' | 'exists';

/**
 * Puts Kvali's current `snippet` into `text`: appended when the file has no Kvali block of
 * this kind, replaced in place when an older version of the block is there (any `vN`
 * marker, so wording fixes reach people who added it earlier), left alone when it is
 * current or when its end marker was removed (Kvali never guesses where a block ends).
 */
function withBlock(text: string | undefined, name: string, snippet: string): { text: string; result: WriteResult } {
  if (text === undefined || text === '') return { text: snippet, result: text === undefined ? 'created' : 'added' };
  const open = new RegExp(`<!-- kvali:${name} v\\d+ -->`).exec(text);
  if (open) {
    const close = `<!-- /kvali:${name} -->`;
    const closeAt = text.indexOf(close, open.index);
    if (closeAt === -1) return { text, result: 'exists' };
    const end = closeAt + close.length;
    const crlf = text.includes('\r\n');
    const block = snippet.trimEnd();
    if (text.slice(open.index, end).replace(/\r\n/g, '\n') === block) return { text, result: 'exists' };
    return { text: text.slice(0, open.index) + (crlf ? block.replace(/\n/g, '\r\n') : block) + text.slice(end), result: 'updated' };
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

const PLAN_RULE_END = '<!-- /kvali:plan-rule -->';

/** Removes Kvali's plan rule from every global instruction file. Files that end up empty are deleted. */
export async function removeGlobalPlanRule(home: string, env: Record<string, string | undefined> = {}): Promise<string[]> {
  const changed: string[] = [];
  for (const target of globalInstructionFiles(home, env)) {
    let text: string;
    try {
      text = await fsp.readFile(target.file, 'utf8');
    } catch {
      continue;
    }
    const start = text.search(/<!-- kvali:plan-rule v\d+ -->/);
    if (start === -1) continue;
    const endAt = text.indexOf(PLAN_RULE_END, start);
    const end = endAt === -1 ? text.length : endAt + PLAN_RULE_END.length;
    const next = (text.slice(0, start).replace(/\n+$/, '\n') + text.slice(end).replace(/^\n+/, '')).replace(/^\n+$/, '');
    if (next.trim() === '') await fsp.unlink(target.file);
    else await fsp.writeFile(target.file, next);
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
    if (next.result !== 'exists') await fsp.writeFile(target.file, next.text);
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
  if (next.result !== 'exists') await fsp.writeFile(file, next.text);
  return { file, result: current === undefined ? 'created' : next.result };
}
