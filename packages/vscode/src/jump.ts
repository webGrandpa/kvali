/**
 * "Go to agent": takes the person to where a session runs.
 *
 * 1. A terminal of this window that runs the agent: the agent's own process when its files name
 *    it (Copilot, Cline's SDK), else a process of that agent, started in the session's project,
 *    under one of the terminals.
 * 2. Another window that has the session's project open: that window is brought to the front
 *    (opening a folder that is already open focuses its window) and asked to do step 1.
 * 3. An agent that lives in an editor panel (Cline, Roo Code, Kilo Code, Copilot Chat, the
 *    Claude Code and Codex extensions): its panel, when that extension is installed here.
 */
import * as vscode from 'vscode';
import { pathWithin, type AgentId, type AgentSession } from '@kvali/core';
import { AGENT_PROCESS, childrenOf, descendants, isAncestor, processCwds, processTable, type Proc } from './processes.ts';
import { SAFE_ID, safeFile, safeFolder } from './paths.ts';
import type { WindowRegistry } from './windows.ts';

/** Commands that open an agent's own panel, most specific first. Only those that exist here are used. */
export const AGENT_PANEL: Partial<Record<AgentId, string[]>> = {
  copilot: ['workbench.action.chat.open'],
  cline: ['claude-dev.SidebarProvider.focus', 'cline.focusChatInput'],
  'roo-code': ['roo-cline.SidebarProvider.focus', 'roo-cline.focusInput'],
  'kilo-code': ['kilo-code.SidebarProvider.focus'],
};

/**
 * Commands that open one session's own chat, given its id. The Claude Code extension's
 * "Open in New Tab" (`claude-vscode.editor.open`) takes a session id: it shows that session's
 * tab, or opens the session again when its tab was closed.
 */
export const SESSION_PANEL: Partial<Record<AgentId, string>> = {
  'claude-code': 'claude-vscode.editor.open',
};

/** The editor extensions an agent comes as: their own views are its panel too. */
export const AGENT_EXTENSIONS: Partial<Record<AgentId, string[]>> = {
  'claude-code': ['anthropic.claude-code'],
  codex: ['openai.chatgpt'],
  copilot: ['github.copilot-chat'],
  cline: ['saoudrizwan.claude-dev'],
  'roo-code': ['rooveterinaryinc.roo-cline'],
  'kilo-code': ['kilocode.kilo-code'],
};

export type JumpResult = 'terminal' | 'window' | 'panel' | 'none';

export interface JumpDeps {
  windows: WindowRegistry;
  roots: () => string[];
  log: (message: string) => void;
}

/** Which of these terminals runs the session's agent, if one does. */
export async function findTerminal(
  s: AgentSession,
  terminals: readonly vscode.Terminal[],
  pick: (choices: { terminal: vscode.Terminal; label: string }[]) => Promise<vscode.Terminal | undefined>,
): Promise<vscode.Terminal | undefined> {
  const shells = (await Promise.all(terminals.map(async (t) => ({ t, pid: await t.processId.then((p) => p, () => undefined) })))).filter(
    (x): x is { t: vscode.Terminal; pid: number } => typeof x.pid === 'number' && x.pid > 0,
  );
  if (!shells.length) return undefined;
  const table = await processTable();
  if (!table.size) return undefined;

  if (s.pid) {
    const hit = shells.find((x) => isAncestor(table, x.pid, s.pid!));
    if (hit) return hit.t;
  }
  const sig = AGENT_PROCESS[s.agent];
  if (!sig) return undefined;
  const kids = childrenOf(table);
  const candidates: { t: vscode.Terminal; proc: Proc }[] = [];
  for (const x of shells) {
    // The topmost matching process per chain: a wrapper and the binary it starts are one agent.
    const procs = descendants(kids, x.pid).filter((p) => sig.test(p.args));
    for (const p of procs) if (!procs.some((q) => q.pid === p.ppid)) candidates.push({ t: x.t, proc: p });
  }
  if (!candidates.length) return undefined;

  const cwds = await processCwds(candidates.map((c) => c.proc.pid));
  const where = s.projectPath ?? s.cwd;
  const inProject = candidates.filter((c) => {
    const cwd = cwds.get(c.proc.pid);
    return cwd === undefined ? cwds.size === 0 : !where || pathWithin(cwd, where) || (s.cwd !== undefined && pathWithin(cwd, s.cwd));
  });
  const terms = [...new Set(inProject.map((c) => c.t))];
  if (terms.length === 1) return terms[0];
  if (terms.length > 1) {
    return pick(
      terms.map((terminal) => {
        const c = inProject.find((x) => x.t === terminal)!;
        return { terminal, label: `${terminal.name} — ${c.proc.args.slice(0, 80)}` };
      }),
    );
  }
  return undefined;
}

/** A command this editor has that opens the agent's panel: a known one, else the focus command of a view its extension adds. */
async function panelCommand(agent: AgentId): Promise<string | undefined> {
  const all = new Set(await vscode.commands.getCommands(true));
  for (const c of AGENT_PANEL[agent] ?? []) if (all.has(c)) return c;
  for (const id of AGENT_EXTENSIONS[agent] ?? []) {
    const views = vscode.extensions.getExtension(id)?.packageJSON?.contributes?.views as Record<string, { id?: unknown }[]> | undefined;
    for (const list of Object.values(views ?? {})) {
      for (const v of Array.isArray(list) ? list : []) if (typeof v?.id === 'string' && all.has(`${v.id}.focus`)) return `${v.id}.focus`;
    }
  }
  return undefined;
}

/** The session's terminal in this window, focused, when there is one. */
async function terminalHere(s: AgentSession, deps: JumpDeps): Promise<boolean> {
  if (s.host === 'editor') return false;
  try {
    const t = await findTerminal(s, vscode.window.terminals, async (choices) => {
      const c = await vscode.window.showQuickPick(
        choices.map((x) => ({ label: x.label, terminal: x.terminal })),
        { placeHolder: `More than one terminal runs ${s.agentLabel} in this project: which one?` },
      );
      return c?.terminal;
    });
    if (!t) return false;
    t.show(false);
    return true;
  } catch (e) {
    deps.log(`Go to agent: could not read the terminals' processes: ${String(e)}`);
    return false;
  }
}

/** The agent's own panel in this window, opened, when the agent has one and runs in an editor (or may). */
async function panelHere(s: AgentSession): Promise<boolean> {
  if (s.host === 'terminal' && AGENT_PROCESS[s.agent]) return false;
  // A session of an agent's editor extension: its own chat, open or closed.
  const open = SESSION_PANEL[s.agent];
  if (open && s.host === 'editor' && SAFE_ID.test(s.id) && (await vscode.commands.getCommands(true)).includes(open)) {
    await vscode.commands.executeCommand(open, s.id);
    return true;
  }
  const cmd = await panelCommand(s.agent);
  if (!cmd) return false;
  await vscode.commands.executeCommand(cmd);
  return true;
}

/** Takes the person to the session in this window: its terminal, or its agent's panel. */
export async function jumpHere(s: AgentSession, deps: JumpDeps): Promise<JumpResult> {
  if (await terminalHere(s, deps)) return 'terminal';
  if (await panelHere(s)) return 'panel';
  return 'none';
}

/** Takes the person to the session, wherever it is: a terminal here, the window that has its project, or the agent's panel. */
export async function goToAgent(s: AgentSession, deps: JumpDeps): Promise<JumpResult> {
  if (await terminalHere(s, deps)) return 'terminal';
  const here = deps.roots().some((r) => pathWithin(s.projectPath, r));
  const other = !here ? deps.windows.ownerOf(s.projectPath) : undefined;
  const target = other && ((await safeFile(other.workspaceFile)) ?? (await safeFolder(other.roots.find((r) => pathWithin(s.projectPath, r)))));
  if (other && target) {
    await deps.windows.requestFocus(other.id, s.key);
    // Opening a folder that a window already has open brings that window to the front.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    return 'window';
  }
  if (await panelHere(s)) return 'panel';
  return 'none';
}
