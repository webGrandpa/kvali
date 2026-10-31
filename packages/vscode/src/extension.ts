import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  Engine,
  HookHub,
  Pricing,
  addProgressProtocol,
  applySetup,
  claudeHookReply,
  claudeHooksStatus,
  claudeSettingsPath,
  createDefaultAdapters,
  defaultLiveDir,
  detectAgents,
  detectedLabels,
  installClaudeHooks,
  newPhoneConfig,
  pathWithin,
  progressOf,
  pruneLiveDir,
  readPhoneConfig,
  removeSetup,
  sendPush,
  setupChanges,
  testPush,
  uninstallClaudeHooks,
  writePhoneConfig,
  type AgentSession,
  type DetectedAgents,
  type HookStatus,
  type Snapshot,
} from '@kvali/core';
import { readConfig, type KvaliConfig } from './config.ts';
import type { FromWebview, SetupState } from './messages.ts';
import { Notifier } from './notifier.ts';
import { AgentsView } from './panel.ts';
import { PhoneSender } from './phone.ts';
import { StatusBar } from './statusbar.ts';
import { WindowRegistry } from './windows.ts';

const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;
const SETUP_KEY = 'kvali.setup';
const REPO = 'https://github.com/webGrandpa/kvali';

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
  let detected: DetectedAgents = { claude: false, codex: false, gemini: false, antigravity: false };
  const setupState = (): SetupState => (context.globalState.get<string>(SETUP_KEY) as SetupState | undefined) ?? 'unset';

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
    // Automatic planning: while a Claude session has no unfinished plan, the prompt hook asks for one.
    respond: (agent, ev) => {
      if (agent !== 'claude-code' || !config.autoPlan) return undefined;
      const session = engine.snapshot.sessions.find((s) => s.agent === 'claude-code' && s.id === ev.sessionId);
      return claudeHookReply(ev, session);
    },
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

  const phone = new PhoneSender(home, () => hub.isHub, log);
  let phoneCard = false;

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
      setup: setupState(),
      detected: detectedLabels(detected),
      setupChanges: setupChanges(detected),
      isHub: hub.isHub,
      activeWindowHours: config.activeWindowHours,
      home,
      phone: phone.view(),
      phoneCard,
    });
  }

  function refreshStatusBar(): void {
    statusBar.update(engine.snapshot, roots(), config.statusBar, config.showCost);
  }

  engine.onSnapshot((snap) => {
    refreshStatusBar();
    notifier.update(snap);
    const hadPhone = !!phone.config;
    void phone.update(snap).then(() => {
      if (!!phone.config !== hadPhone) pushState();
    });
    pushState();
  });

  /** One step to the phone: a private topic, the QR code in the panel, a test notification. */
  async function phoneSetup(): Promise<void> {
    let cfg = await readPhoneConfig(home);
    if (!cfg) {
      cfg = newPhoneConfig();
      await writePhoneConfig(home, cfg);
      log.info(`Phone notifications set up on ${cfg.server} (topic ${cfg.topic})`);
    }
    await phone.reload(true);
    phoneCard = true;
    pushState();
    await vscode.commands.executeCommand('kvali.show');
    await phoneTest(true);
  }

  async function phoneTest(quietOnSuccess = false): Promise<void> {
    await phone.reload(true);
    const cfg = phone.config;
    if (!cfg) {
      void vscode.window.showInformationMessage('Phone notifications are not set up yet.', 'Set up').then((c) => c && phoneSetup());
      return;
    }
    const r = await sendPush(cfg, testPush());
    if (r.ok) {
      if (!quietOnSuccess) void vscode.window.showInformationMessage('Kvali sent a test notification to your phone.');
    } else {
      log.warn(`Phone test failed: ${r.error}`);
      void vscode.window.showWarningMessage(`Kvali could not send to your phone: ${r.error}. Check the network (a VPN, proxy or firewall may block ${new URL(cfg.server).host}).`);
    }
  }

  async function refreshHookStatus(): Promise<void> {
    claudeHooks = await claudeHooksStatus(claudeSettingsPath(home), config.port).catch(() => 'not-installed' as const);
    pushState();
  }

  /** Turns everything on in one go: hooks for Claude Code, planning rules for Codex and Gemini/Antigravity. */
  async function turnOn(): Promise<boolean> {
    detected = await detectAgents(home, process.env);
    try {
      await applySetup(home, process.env, config.port, detected);
      await context.globalState.update(SETUP_KEY, 'on');
      await refreshHookStatus();
      log.info(`Setup applied: ${setupChanges(detected).join('; ')}`);
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`Kvali setup failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Keeps an accepted setup current after updates (new hook layout, port change, newly installed agents). */
  async function repairSetup(): Promise<void> {
    detected = await detectAgents(home, process.env);
    await refreshHookStatus();
    if (setupState() !== 'on') {
      pushState();
      return;
    }
    try {
      if (detected.claude && claudeHooks !== 'installed') log.info('Updating Claude Code hooks to the current layout');
      await applySetup(home, process.env, config.port, detected);
      await refreshHookStatus();
    } catch (err) {
      log.warn(`Could not refresh setup: ${(err as Error).message}`);
    }
  }

  async function offerSetup(): Promise<void> {
    if (setupState() !== 'unset') return;
    const labels = detectedLabels(detected);
    if (!labels.length) return;
    const choice = await vscode.window.showInformationMessage(
      `Kvali found ${labels.join(', ')}. Turn on "needs you" alerts and automatic plans, so every task gets a progress bar?`,
      'Turn on',
      'Not now',
    );
    if (choice === 'Turn on' && (await turnOn())) {
      void vscode.window.showInformationMessage('Kvali is fully on. New agent sessions will keep a plan. Undo anytime with "Kvali: Turn Off".');
    } else if (choice === 'Not now') {
      await context.globalState.update(SETUP_KEY, 'off');
      pushState();
    }
  }

  function findSession(key: string): AgentSession | undefined {
    return engine.snapshot.sessions.find((s) => s.key === key);
  }

  async function reportProblem(): Promise<void> {
    const snap = engine.snapshot;
    const version = String(context.extension.packageJSON.version ?? '?');
    const rows = new Map<string, { sessions: number; versions: Set<string>; statuses: Map<string, number>; noPlan: number; tokens: number }>();
    for (const s of snap.sessions) {
      const r = rows.get(s.agent) ?? { sessions: 0, versions: new Set(), statuses: new Map(), noPlan: 0, tokens: 0 };
      r.sessions += 1;
      if (s.agentVersion) r.versions.add(s.agentVersion);
      r.statuses.set(s.status, (r.statuses.get(s.status) ?? 0) + 1);
      if (progressOf(s.tasks).total === 0) r.noPlan += 1;
      if (s.tokens) r.tokens += 1;
      rows.set(s.agent, r);
    }
    const table = [...rows].map(
      ([agent, r]) =>
        `| ${agent} | ${r.sessions} | ${[...r.versions].slice(0, 3).join(', ') || '–'} | ${[...r.statuses].map(([k, v]) => `${k} ${v}`).join(', ')} | ${r.noPlan} | ${r.tokens} |`,
    );
    const body = [
      '**What happened, and what did you expect?**',
      '',
      '',
      '---',
      `Kvali ${version} · ${vscode.env.appName} ${vscode.version} · ${process.platform}-${process.arch}`,
      `Setup: ${setupState()} · Claude hooks: ${claudeHooks} · agents found: ${detectedLabels(detected).join(', ') || 'none'}`,
      '',
      '| Agent | Sessions | Versions | Status | Without plan | With tokens |',
      '| --- | --- | --- | --- | --- | --- |',
      ...table,
      '',
      snap.errors.length ? `Errors:\n${snap.errors.map((e) => `- ${e.agent}: ${e.message}`).join('\n')}` : 'Errors: none',
      '',
      '_Generated by "Kvali: Report a Problem". It contains no prompts, titles, paths or code._',
    ].join('\n');
    await vscode.env.clipboard.writeText(body);
    const url = `${REPO}/issues/new?title=${encodeURIComponent('Problem: ')}&body=${encodeURIComponent(body)}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async function onMessage(m: FromWebview): Promise<void> {
    switch (m?.type) {
      case 'setScope':
        await vscode.workspace.getConfiguration('kvali').update('scope', m.scope, vscode.ConfigurationTarget.Global);
        return;
      case 'runSetup':
        // Clicking "Turn on" on the setup card, which lists every change, is the consent.
        if (await turnOn()) void vscode.window.showInformationMessage('Kvali is fully on. Undo anytime with "Kvali: Turn Off".');
        return;
      case 'dismissSetup':
        await context.globalState.update(SETUP_KEY, 'off');
        pushState();
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
      case 'copy':
        if (typeof m.text === 'string' && m.text.length < 500) {
          await vscode.env.clipboard.writeText(m.text);
          void vscode.window.setStatusBarMessage('Kvali: copied', 2_000);
        }
        return;
      case 'hidePhoneCard':
        phoneCard = false;
        pushState();
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
    vscode.commands.registerCommand('kvali.reportProblem', () => reportProblem()),
    vscode.commands.registerCommand('kvali.phoneSetup', () => phoneSetup()),
    vscode.commands.registerCommand('kvali.phoneTest', () => phoneTest()),
    vscode.commands.registerCommand('kvali.phoneOff', async () => {
      await writePhoneConfig(home, undefined);
      await phone.reload(true);
      phoneCard = false;
      pushState();
      void vscode.window.showInformationMessage('Phone notifications are off. You can remove the Kvali topic from the ntfy app too.');
    }),

    vscode.commands.registerCommand('kvali.setup', async () => {
      detected = await detectAgents(home, process.env);
      const changes = setupChanges(detected);
      if (!changes.length) {
        void vscode.window.showWarningMessage('Kvali did not find Claude Code, Codex, Gemini CLI or Antigravity on this machine.');
        return;
      }
      const ok = await vscode.window.showInformationMessage(
        'Turn on alerts and automatic plans?',
        {
          modal: true,
          detail: `${changes.map((c) => `• ${c}`).join('\n')}\n\nEverything Kvali adds is marked, keeps your own settings, and is removed automatically if you uninstall Kvali.`,
        },
        'Turn on',
      );
      if (ok === 'Turn on' && (await turnOn())) void vscode.window.showInformationMessage('Kvali is fully on.');
    }),

    vscode.commands.registerCommand('kvali.turnOff', async () => {
      await removeSetup(home, process.env);
      await context.globalState.update(SETUP_KEY, 'off');
      await refreshHookStatus();
      void vscode.window.showInformationMessage('Kvali removed its hooks and planning rules. Tracking from agent files keeps working.');
    }),

    vscode.commands.registerCommand('kvali.installClaudeHooks', async () => {
      try {
        await installClaudeHooks(claudeSettingsPath(home), config.port);
        await refreshHookStatus();
        void vscode.window.showInformationMessage('Kvali hooks installed. New Claude Code sessions use them; restart sessions that are already running.');
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
      if (r.result === 'exists' || r.result === 'updated') {
        void vscode.window.showInformationMessage(
          r.result === 'exists' ? 'AGENTS.md already contains the current progress protocol.' : 'Updated the progress protocol in AGENTS.md to the current version.',
        );
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
        void vscode.window.showInformationMessage('Kvali: reload the window to use the new hook port.');
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
  refreshStatusBar();
  void repairSetup().then(() => offerSetup());
  log.info(`Kvali started (home ${home}, ${roots().length} workspace folder(s))`);

  return {
    getSnapshot: () => engine.snapshot,
    onDidChangeSnapshot: (listener) => new vscode.Disposable(engine.onSnapshot(listener)),
  };
}

export function deactivate(): void {}
