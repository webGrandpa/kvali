import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  Engine,
  HookHub,
  Pricing,
  addProgressProtocol,
  claudeHooksStatus,
  claudeSettingsPath,
  createDefaultAdapters,
  defaultLiveDir,
  installClaudeHooks,
  pathWithin,
  pruneLiveDir,
  uninstallClaudeHooks,
  type AgentSession,
  type HookStatus,
  type Snapshot,
} from '@kvali/core';
import { readConfig, type KvaliConfig } from './config.ts';
import type { FromWebview } from './messages.ts';
import { Notifier } from './notifier.ts';
import { AgentsView } from './panel.ts';
import { StatusBar } from './statusbar.ts';
import { WindowRegistry } from './windows.ts';

const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;

/** Public API returned from `activate`, so other extensions (and tests) can read Kvali's data. */
export interface KvaliApi {
  getSnapshot(): Snapshot;
  onDidChangeSnapshot(listener: (s: Snapshot) => void): vscode.Disposable;
}

export function activate(context: vscode.ExtensionContext): KvaliApi {
  const log = vscode.window.createOutputChannel('Kvali', { log: true });
  const home = os.homedir();
  const liveDir = defaultLiveDir(home);
  let config: KvaliConfig = readConfig();
  let claudeHooks: HookStatus = 'not-installed';

  const roots = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  const inWorkspace = (s: AgentSession) => roots().some((r) => pathWithin(s.projectPath, r));

  const engine = new Engine({
    home,
    liveDir,
    intervalMs: config.pollIntervalMs,
    activeWindowMs: config.activeWindowHours * 3_600_000,
    staleAfterMs: config.staleAfterMinutes * 60_000,
    workspaceRoots: roots(),
    pricing: new Pricing(config.pricing),
    disabled: config.disabled,
    extraAntigravityBrainDirs: config.brainDirs,
    log: (m) => log.warn(m),
  });

  const windows = new WindowRegistry(path.join(home, '.kvali', 'windows'), roots);

  const hub = new HookHub({
    port: config.port,
    liveDir,
    log: (m) => log.info(m),
    onEvent: (agent, ev) => {
      log.trace(`hook ${agent} ${ev.event}${ev.notificationType ? ` (${ev.notificationType})` : ''} ${ev.sessionId}`);
      void engine.tick();
    },
    onRoleChange: (isHub) => {
      log.info(isHub ? `Listening for agent hooks on 127.0.0.1:${config.port}` : 'Another window receives agent hooks');
      if (isHub) void pruneLiveDir(liveDir);
      pushState();
    },
  });

  const view = new AgentsView(context.extensionUri, (m) => void onMessage(m));
  const statusBar = new StatusBar();
  const notifier = new Notifier({
    config: () => config,
    // Notify for sessions in this workspace; the hook hub also covers sessions no open window claims.
    owns: (s) => inWorkspace(s) || (hub.isHub && !windows.claimedElsewhere(s.projectPath)),
    reveal: () => void vscode.commands.executeCommand('kvali.show'),
  });

  function pushState(): void {
    view.post({
      type: 'state',
      snapshot: engine.snapshot,
      workspaceRoots: roots(),
      scope: config.scope,
      showCost: config.showCost,
      claudeHooks,
      isHub: hub.isHub,
      activeWindowHours: config.activeWindowHours,
      home,
    });
  }

  function refreshStatusBar(): void {
    statusBar.update(engine.snapshot, roots(), config.statusBar, config.showCost);
  }

  engine.onSnapshot((snap) => {
    refreshStatusBar();
    notifier.update(snap);
    pushState();
  });

  async function refreshHookStatus(): Promise<void> {
    claudeHooks = await claudeHooksStatus(claudeSettingsPath(home), config.port).catch(() => 'not-installed' as const);
    pushState();
  }

  function findSession(key: string): AgentSession | undefined {
    return engine.snapshot.sessions.find((s) => s.key === key);
  }

  async function onMessage(m: FromWebview): Promise<void> {
    switch (m?.type) {
      case 'setScope':
        await vscode.workspace.getConfiguration('kvali').update('scope', m.scope, vscode.ConfigurationTarget.Global);
        return;
      case 'open': {
        const s = findSession(m.key);
        const file = s?.sources[0];
        if (file) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        return;
      }
      case 'resume': {
        const s = findSession(m.key);
        if (!s || !SAFE_ID.test(s.id)) return;
        const cmd = s.agent === 'claude-code' ? `claude --resume ${s.id}` : s.agent === 'codex' ? `codex resume ${s.id}` : undefined;
        if (!cmd) return;
        const term = vscode.window.createTerminal({ name: `${s.agentLabel}: ${s.title.slice(0, 30)}`, cwd: s.cwd ?? s.projectPath });
        term.show();
        term.sendText(cmd);
        return;
      }
      case 'command':
        await vscode.commands.executeCommand(m.command);
        return;
      default:
        return;
    }
  }

  context.subscriptions.push(
    log,
    statusBar,
    vscode.window.registerWebviewViewProvider(AgentsView.viewId, view, { webviewOptions: { retainContextWhenHidden: false } }),

    vscode.commands.registerCommand('kvali.show', () => vscode.commands.executeCommand('workbench.view.extension.kvali')),
    vscode.commands.registerCommand('kvali.refresh', async () => {
      await engine.tick();
      pushState();
    }),
    vscode.commands.registerCommand('kvali.showLog', () => log.show()),
    vscode.commands.registerCommand('kvali.toggleScope', () =>
      vscode.workspace.getConfiguration('kvali').update('scope', config.scope === 'all' ? 'workspace' : 'all', vscode.ConfigurationTarget.Global),
    ),

    vscode.commands.registerCommand('kvali.installClaudeHooks', async () => {
      const file = claudeSettingsPath(home);
      const ok = await vscode.window.showInformationMessage(
        'Install Kvali hooks for Claude Code?',
        {
          modal: true,
          detail:
            `Adds four async hooks to ${file} (prompt submitted, needs your input, finished, session ended). ` +
            `Each one forwards the event to 127.0.0.1:${config.port} with curl and always succeeds, so Claude Code is never slowed down or blocked. ` +
            'Prompts and code are never stored. Your current file is backed up as settings.json.kvali-backup.',
        },
        'Install',
      );
      if (ok !== 'Install') return;
      try {
        await installClaudeHooks(file, config.port);
        await refreshHookStatus();
        void vscode.window.showInformationMessage('Kvali hooks installed. New and running Claude Code sessions pick them up automatically.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not install hooks: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('kvali.uninstallClaudeHooks', async () => {
      try {
        const r = await uninstallClaudeHooks(claudeSettingsPath(home));
        await refreshHookStatus();
        void vscode.window.showInformationMessage(r.changed ? 'Kvali hooks removed from Claude Code settings.' : 'No Kvali hooks were installed.');
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not remove hooks: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('kvali.addProgressProtocol', async () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
      if (!folders.length) {
        void vscode.window.showWarningMessage('Open a folder first.');
        return;
      }
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Add the progress protocol to which folder?' });
      if (!folder) return;
      const r = await addProgressProtocol(folder.uri.fsPath);
      await vscode.window.showTextDocument(vscode.Uri.file(r.file), { preview: false });
      if (r.result === 'exists') {
        void vscode.window.showInformationMessage('AGENTS.md already contains the progress protocol.');
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        'Progress protocol added to AGENTS.md. Agents without a built-in plan tool will now keep .agents/progress.md up to date. Ignore that file in git?',
        'Add to .gitignore',
      );
      if (choice) {
        const gi = vscode.Uri.file(path.join(folder.uri.fsPath, '.gitignore'));
        let text = '';
        try {
          text = Buffer.from(await vscode.workspace.fs.readFile(gi)).toString('utf8');
        } catch {
          /* no .gitignore yet */
        }
        if (!/^\.agents\/progress/m.test(text)) {
          const sep = text && !text.endsWith('\n') ? '\n' : '';
          await vscode.workspace.fs.writeFile(gi, Buffer.from(`${text}${sep}.agents/progress*\n`));
        }
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engine.configure({ workspaceRoots: roots() });
      void windows.beat();
      void engine.tick();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('kvali')) return;
      const before = config;
      config = readConfig();
      engine.configure({
        activeWindowMs: config.activeWindowHours * 3_600_000,
        staleAfterMs: config.staleAfterMinutes * 60_000,
        intervalMs: config.pollIntervalMs,
        pricing: new Pricing(config.pricing),
        disabled: config.disabled,
      });
      if (JSON.stringify(before.brainDirs) !== JSON.stringify(config.brainDirs)) {
        engine.setAdapters(createDefaultAdapters({ extraAntigravityBrainDirs: config.brainDirs }));
      }
      if (before.port !== config.port) {
        void vscode.window.showInformationMessage('Kvali: reload the window and reinstall the Claude Code hooks to use the new port.');
      }
      refreshStatusBar();
      pushState();
      void engine.tick();
    }),

    { dispose: () => engine.dispose() },
    { dispose: () => hub.dispose() },
    { dispose: () => windows.dispose() },
    { dispose: () => notifier.dispose() },
  );

  // Time-based labels in the status bar ("done" fades after 30 minutes).
  const clock = setInterval(refreshStatusBar, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(clock) });

  windows.start();
  hub.start();
  engine.start();
  void refreshHookStatus();
  refreshStatusBar();
  log.info(`Kvali started (home ${home}, ${roots().length} workspace folder(s))`);

  return {
    getSnapshot: () => engine.snapshot,
    onDidChangeSnapshot: (listener) => new vscode.Disposable(engine.onSnapshot(listener)),
  };
}

export function deactivate(): void {}
