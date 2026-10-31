import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const PROGRESS_PROTOCOL_MARKER = '<!-- kvali:progress-protocol v1 -->';

/** The AGENTS.md section that asks any agent to keep its plan visible. */
export function progressProtocolSnippet(): string {
  return `${PROGRESS_PROTOCOL_MARKER}
## Progress reporting

For any task that takes more than two steps, keep your plan visible so the user can follow progress without asking:

- If you have a built-in plan or todo tool (Claude Code Tasks/TodoWrite, Codex \`update_plan\`, Gemini CLI \`write_todos\`, Antigravity \`task.md\`), create the plan before you start and update it as you go.
- Otherwise, maintain \`.agents/progress.md\` in this format:

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

/**
 * Appends the protocol to `<root>/AGENTS.md` (creating it if needed).
 * Returns `exists` when the section is already there.
 */
export async function addProgressProtocol(root: string): Promise<{ file: string; result: 'added' | 'created' | 'exists' }> {
  const file = path.join(root, 'AGENTS.md');
  let current: string | undefined;
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current?.includes(PROGRESS_PROTOCOL_MARKER)) return { file, result: 'exists' };
  if (current === undefined) {
    await fsp.writeFile(file, `# AGENTS.md\n\n${progressProtocolSnippet()}`);
    return { file, result: 'created' };
  }
  const sep = current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  await fsp.writeFile(file, `${current}${sep}${progressProtocolSnippet()}`);
  return { file, result: 'added' };
}
