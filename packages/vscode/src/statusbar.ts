import * as vscode from 'vscode';
import {
  STATUS_LABEL,
  currentTask,
  fmtTokens,
  fmtUsd,
  pathWithin,
  progressOf,
  projectName,
  sessionTokens,
  type AgentSession,
  type Snapshot,
} from '@kvali/core';

const RECENT_MS = 30 * 60_000;

function short(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The single status bar item: the most relevant agent of this workspace, or any agent that needs you. */
export class StatusBar {
  private readonly item = vscode.window.createStatusBarItem('kvali.status', vscode.StatusBarAlignment.Left, -10);

  constructor() {
    this.item.name = 'Kvali';
    this.item.command = 'kvali.show';
  }

  update(snapshot: Snapshot, roots: readonly string[], enabled: boolean, showCost: boolean): void {
    if (!enabled) {
      this.item.hide();
      return;
    }
    const now = Date.now();
    const inWs = (s: AgentSession) => roots.some((r) => pathWithin(s.projectPath, r));
    const ws = snapshot.sessions.filter(inWs);
    const waiting = snapshot.sessions.filter((s) => s.status === 'waiting');
    const working = ws.filter((s) => s.status === 'working');

    this.item.backgroundColor = undefined;
    if (waiting.length) {
      const s = waiting.find(inWs) ?? waiting[0];
      const where = inWs(s) ? '' : ` · ${projectName(s.projectPath)}`;
      this.item.text = `$(bell-dot) ${s.agentLabel}: ${short(s.statusDetail ?? 'needs you', 40)}${where}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (working.length) {
      const s = working[0];
      const p = progressOf(s.tasks);
      const step = currentTask(s.tasks);
      const label = step?.activeTitle ?? step?.title ?? s.activity?.label;
      const tok = sessionTokens(s);
      const parts = [p.total ? `${p.done}/${p.total} · ${p.percent}%` : s.turn ? `${s.agentLabel} · ${s.turn.steps} steps` : s.agentLabel];
      if (label) parts.push(short(label, 32));
      if (tok) parts.push(fmtTokens(tok));
      if (working.length > 1) parts.push(`+${working.length - 1}`);
      const quiet = now - s.updatedAt;
      const running = s.activity && !s.activity.endedAt && s.activity.kind !== 'thinking' && s.activity.kind !== 'message';
      const stuck = (!!s.trouble && now - s.trouble.at < 15 * 60_000) || (!running && quiet > 5 * 60_000);
      this.item.text = `${stuck ? '$(warning)' : '$(sync~spin)'} ${parts.join(' · ')}${stuck ? ` · quiet ${Math.round(quiet / 60_000)}m` : ''}`;
    } else {
      const recent = ws.find((s) => now - s.updatedAt < RECENT_MS);
      if (recent) {
        const p = progressOf(recent.tasks);
        const icon = recent.status === 'done' ? '$(check)' : recent.status === 'error' ? '$(error)' : '$(circle-large-outline)';
        const what = recent.status === 'done' && p.total ? `Done ${p.done}/${p.total}` : `${recent.agentLabel} ${STATUS_LABEL[recent.status].toLowerCase()}`;
        this.item.text = `${icon} ${what}`;
      } else {
        this.item.text = '$(pulse)';
      }
    }
    this.item.tooltip = this.tooltip(ws.length ? ws : snapshot.sessions.slice(0, 5), ws.length > 0, showCost);
    this.item.show();
  }

  private tooltip(sessions: AgentSession[], workspace: boolean, showCost: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    if (!sessions.length) {
      md.appendMarkdown('**Kvali** — no agent sessions yet. Start Claude Code, Codex, Gemini CLI or Antigravity.');
      return md;
    }
    md.appendMarkdown(`**Kvali** — ${workspace ? 'this workspace' : 'recent sessions'}\n\n`);
    for (const s of sessions.slice(0, 6)) {
      const p = progressOf(s.tasks);
      const tok = sessionTokens(s);
      const bits = [
        STATUS_LABEL[s.status],
        p.total ? `${p.done}/${p.total} tasks (${p.percent}%)` : undefined,
        tok ? `${fmtTokens(tok)} tokens` : undefined,
        showCost && s.costUsd !== undefined ? `API value ${fmtUsd(s.costUsd)}` : undefined,
      ].filter(Boolean);
      const esc = (t: string) => t.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);
      md.appendMarkdown(`**${esc(s.agentLabel)}** · ${esc(short(s.title, 60))}  \n${bits.join(' · ')}\n\n`);
    }
    md.appendMarkdown('_Click to open the Agents view_');
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
