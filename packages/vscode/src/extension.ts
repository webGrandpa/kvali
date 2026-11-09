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
  claudePluginEnabled,
  claudeSettingsPath,
  createDefaultAdapters,
  defaultLiveDir,
  detectAgents,
  detectedLabels,
  installClaudeHooks,
  newPhoneConfig,
  newTopic,
  pathWithin,
  pluginRunsIn,
  projectName,
  progressOf,
  pruneLiveDir,
  readPhoneConfig,
  redactPaths,
  removeSetup,
  setKvaliOption,
  sendPush,
  setupChanges,
  telegramBot,
  telegramFindChat,
  discordCheck,
  channelNames,
  testPush,
  uninstallClaudeHooks,
  weekSnapshot,
  weekStats,
  writePhoneConfig,
  DEFAULT_DONE_AFTER_SEC,
  DEFAULT_NTFY_SERVER,
  DEFAULT_PHONE_EVENTS,
  DISCORD_WEBHOOK_RE,
  DONE_AFTER_CHOICES,
  PHONE_EVENTS,
  TELEGRAM_TOKEN_RE,
  type PhoneConfig,
  type AgentSession,
  type DetectedAgents,
  type HookStatus,
  type SetupOptions,
  type Snapshot,
} from '@kvali/core';
import { readConfig, type KvaliConfig } from './config.ts';
import type { FromWebview, SetupState } from './messages.ts';
import { Notifier } from './notifier.ts';
import { AgentsView } from './panel.ts';
import { PhoneSender } from './phone.ts';
import { SharePanel } from './share.ts';
import { StatusBar } from './statusbar.ts';
import { goToAgent, jumpHere, type JumpDeps } from './jump.ts';
import { WindowRegistry } from './windows.ts';

const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;
const SETUP_KEY = 'kvali.setup';
const REPO = 'https://github.com/webGrandpa/kvali';

/** Public API returned from `activate`, so other extensions (and tests) can read Kvali's data. */
export interface KvaliApi {
  getSnapshot(): Snapshot;
  onDidChangeSnapshot(listener: (s: Snapshot) => void): vscode.Disposable;
  /** Takes the person to the session `key` (see "Go to agent"); says where it went. */
  goToAgent(key: string): Promise<'terminal' | 'window' | 'panel' | 'none'>;
}

export function activate(context: vscode.ExtensionContext): KvaliApi {
  const log = vscode.window.createOutputChannel('Kvali', { log: true });
  const home = os.homedir();
  const liveDir = defaultLiveDir(home);
  let config: KvaliConfig = readConfig();
  let claudeHooks: HookStatus = 'not-installed';
  /** How Claude Code is connected: Kvali's plugin, Kvali's hooks (older Claude Code), or not at all. */
  let claudeMode: 'plugin' | 'hooks' | 'none' = 'none';
  const setupOptions = (): SetupOptions => ({
    pluginDir: path.join(context.extensionPath, 'dist', 'claude-plugin'),
    claudeExtensionDirs: vscode.extensions.all.filter((x) => x.id.toLowerCase() === 'anthropic.claude-code').map((x) => x.extensionPath),
    autoPlan: config.autoPlan,
  });
  let detected: DetectedAgents = { claude: false, codex: false, gemini: false, antigravity: false };
  const setupState = (): SetupState => (context.globalState.get<string>(SETUP_KEY) as SetupState | undefined) ?? 'unset';

  const roots = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  const inWorkspace = (s: AgentSession) => roots().some((r) => pathWithin(s.projectPath, r));

  // The globalStorage of the editor Kvali runs in: Cline and Roo Code keep their tasks next to ours.
  const editorStorage = [path.dirname(context.globalStorageUri.fsPath)];
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
    extraEditorStorageDirs: editorStorage,
    log: (m) => log.warn(m),
  });

  const windows = new WindowRegistry(path.join(home, '.kvali', 'windows'), roots, () => {
    const f = vscode.workspace.workspaceFile;
    return f?.scheme === 'file' ? f.fsPath : undefined;
  });
  const jumpDeps: JumpDeps = { windows, roots, log: (m) => log.info(m) };

  const hub = new HookHub({
    port: config.port,
    liveDir,
    log: (m) => log.info(m),
    // Automatic planning: while a Claude session has no unfinished plan, the prompt hook asks for one.
    respond: (agent, ev) => {
      if (agent !== 'claude-code' || !config.autoPlan) return undefined;
      const session = engine.snapshot.sessions.find((s) => s.agent === 'claude-code' && s.id === ev.sessionId);
      return claudeHookReply(ev, session, pluginRunsIn(liveDir, ev.sessionId));
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

  const phone = new PhoneSender(home, () => engine.snapshot, () => hub.isHub, log);
  let phoneCard = false;

  const view = new AgentsView(context.extensionUri, (m) => void onMessage(m));
  const statusBar = new StatusBar();
  const notifier = new Notifier({
    config: () => config,
    // Notify for sessions in this workspace; the hook hub also covers sessions no open window claims.
    owns: (s) => inWorkspace(s) || (hub.isHub && !windows.claimedElsewhere(s.projectPath)),
    reveal: () => void vscode.commands.executeCommand('kvali.show'),
    goTo: (s) => void goTo(s),
  });

  function pushState(): void {
    view.post({
      type: 'state',
      snapshot: engine.snapshot,
      workspaceRoots: roots(),
      scope: config.scope,
      showCost: config.showCost,
      claudeHooks,
      claudeMode,
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
    void windows.checkFocus();
    const hadPhone = !!phone.config;
    void phone.update().then(() => {
      if (!!phone.config !== hadPhone) pushState();
    });
    pushState();
  });

  /** One step to the phone: a private topic, the QR code in the panel, a test notification. */
  async function phoneSetup(): Promise<void> {
    let cfg = await readPhoneConfig(home);
    if (!cfg || !cfg.topic) {
      // Telegram or Discord may be set up already: ntfy joins them.
      cfg = cfg ? { ...cfg, topic: newTopic() } : newPhoneConfig();
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

  /** The phone setup to add a channel to: the existing one, or a new one without ntfy. */
  async function phoneBase(): Promise<PhoneConfig> {
    return (await readPhoneConfig(home)) ?? { server: DEFAULT_NTFY_SERVER, events: [...DEFAULT_PHONE_EVENTS], details: true, doneAfterSec: DEFAULT_DONE_AFTER_SEC };
  }

  async function channelSaved(cfg: PhoneConfig, only: Partial<PhoneConfig>, name: string): Promise<void> {
    await writePhoneConfig(home, cfg);
    await phone.reload(true);
    phoneCard = true;
    pushState();
    // The test goes to the new channel alone.
    const r = await sendPush({ ...cfg, topic: undefined, telegram: undefined, discord: undefined, ...only }, testPush());
    if (r.ok) void vscode.window.showInformationMessage(`Kvali sends notifications to ${name} now (${channelNames(cfg)}). A test is on its way.`);
    else void vscode.window.showWarningMessage(`Kvali saved ${name}, but the test was not sent: ${r.error}`);
  }

  /** Telegram: a bot of the person's own (from @BotFather) writes to them; it may only write to someone who wrote to it first. */
  async function telegramSetup(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      title: 'Kvali → Telegram',
      prompt: 'In Telegram, open @BotFather, send /newbot, choose a name, and paste the token it gives you. It stays on this computer.',
      placeHolder: '123456789:AAF…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (TELEGRAM_TOKEN_RE.test(v.trim()) ? undefined : 'A bot token looks like 123456789:AAF… (from @BotFather)'),
    });
    const token = raw?.trim();
    if (!token) return;
    const me = await telegramBot(token);
    if (!me.ok) {
      void vscode.window.showErrorMessage(`Kvali could not use this bot: ${me.error}.`);
      return;
    }
    const link = `https://t.me/${me.username}`;
    void vscode.window
      .showInformationMessage(`Now send any message to @${me.username} in Telegram: a bot can write only to people who wrote to it first.`, 'Open Telegram')
      .then((c) => c && vscode.env.openExternal(vscode.Uri.parse(link)));
    const chatId = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kvali: waiting for your message to @${me.username}…`, cancellable: true },
      (_progress, cancel) => {
        const ac = new AbortController();
        cancel.onCancellationRequested(() => ac.abort());
        return telegramFindChat(token, 180_000, fetch, ac.signal);
      },
    );
    if (!chatId) {
      void vscode.window.showWarningMessage(`No message reached @${me.username}. Run "Kvali: Send Notifications to Telegram" again and write to the bot while Kvali waits.`);
      return;
    }
    const telegram = { token, chatId, bot: me.username };
    log.info(`Phone notifications: Telegram bot @${me.username} connected`);
    await channelSaved({ ...(await phoneBase()), telegram }, { telegram }, `Telegram (@${me.username})`);
  }

  /** Discord: a webhook of one of the person's channels. */
  async function discordSetup(): Promise<void> {
    const raw = await vscode.window.showInputBox({
      title: 'Kvali → Discord',
      prompt: 'In Discord: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL, and paste it here. It stays on this computer.',
      placeHolder: 'https://discord.com/api/webhooks/…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (DISCORD_WEBHOOK_RE.test(v.trim()) ? undefined : 'A webhook URL looks like https://discord.com/api/webhooks/…'),
    });
    const webhook = raw?.trim();
    if (!webhook) return;
    const check = await discordCheck(webhook);
    if (!check.ok) {
      void vscode.window.showErrorMessage(`Kvali could not use this webhook: ${check.error}.`);
      return;
    }
    log.info('Phone notifications: Discord webhook connected');
    await channelSaved({ ...(await phoneBase()), discord: { webhook } }, { discord: { webhook } }, 'Discord');
  }

  /** "Share My Week": reads every session of the last seven days, then shows the card. */
  async function shareWeek(): Promise<void> {
    const snap = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Kvali: counting this week’s agent work…' },
      () =>
        weekSnapshot({
          home,
          liveDir,
          pricing: new Pricing(config.pricing),
          disabled: config.disabled,
          workspaceRoots: roots(),
          extraAntigravityBrainDirs: config.brainDirs,
          extraEditorStorageDirs: editorStorage,
          log: (m) => log.warn(m),
        }),
    );
    SharePanel.show(context.extensionUri, weekStats(snap.sessions, Date.now()));
  }

  /** Removes one channel; with none left, phone notifications are off. */
  async function channelOff(which: 'telegram' | 'discord'): Promise<void> {
    const cfg = await readPhoneConfig(home);
    if (!cfg?.[which]) return;
    const rest: PhoneConfig = { ...cfg, [which]: undefined };
    await writePhoneConfig(home, rest.topic || rest.telegram || rest.discord ? rest : undefined);
    await phone.reload(true);
    pushState();
    void vscode.window.showInformationMessage(
      which === 'telegram' ? 'Kvali no longer writes to Telegram. You can delete the bot with @BotFather (/deletebot).' : 'Kvali no longer posts to Discord. You can delete the webhook in the channel settings.',
    );
  }

  async function refreshHookStatus(): Promise<void> {
    const settings = claudeSettingsPath(home, process.env);
    claudeHooks = await claudeHooksStatus(settings, config.port).catch(() => 'not-installed' as const);
    claudeMode = (await claudePluginEnabled(settings)) ? 'plugin' : claudeHooks === 'installed' ? 'hooks' : 'none';
    pushState();
  }

  function onMessageText(): string {
    const pane = claudeMode === 'plugin' ? " New Claude Code sessions show Kvali's live pane (type /reload-plugins in open ones)." : '';
    return `Kvali is fully on. New agent sessions keep a plan.${pane} Undo anytime with "Kvali: Turn Off".`;
  }

  /** Mirrors settings the Claude Code plugin reads (it cannot see VS Code's) into ~/.kvali/config.json. */
  async function shareSettings(): Promise<void> {
    await setKvaliOption(home, 'autoPlan', config.autoPlan).catch((err: Error) => log.warn(`Could not save autoPlan: ${err.message}`));
  }

  /** Turns everything on in one go: the plugin for Claude Code (hooks where it has no plugins), planning rules for Codex and Gemini/Antigravity. */
  async function turnOn(): Promise<boolean> {
    detected = await detectAgents(home, process.env);
    try {
      await shareSettings();
      const r = await applySetup(home, process.env, config.port, detected, setupOptions());
      await context.globalState.update(SETUP_KEY, 'on');
      await refreshHookStatus();
      log.info(`Setup applied: ${setupChanges(detected).join('; ')}`);
      if (r.claude === 'plugin') log.info("Claude Code: Kvali's plugin is on (new sessions; /reload-plugins in open ones)");
      if (r.claude === 'hooks') {
        log.info(`Claude Code: using Kvali's hooks${r.claudeNote ? ` (${r.claudeNote})` : ''}`);
        if (r.claudeNote) void vscode.window.showInformationMessage(`Kvali connected Claude Code through hooks: ${r.claudeNote}. Alerts and plans work; the progress pane needs a Claude Code with plugins.`);
      }
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
      await shareSettings();
      const before = claudeMode;
      const r = await applySetup(home, process.env, config.port, detected, setupOptions());
      if (r.claude === 'hooks' && r.claudeNote) log.info(`Claude Code: using Kvali's hooks (${r.claudeNote})`);
      await refreshHookStatus();
      if (before === 'hooks' && claudeMode === 'plugin') {
        log.info("Claude Code: moved from Kvali's hooks to Kvali's plugin");
        void vscode.window.showInformationMessage(
          "Kvali now connects Claude Code through its plugin: new Claude Code sessions show Kvali's live pane (type /reload-plugins in sessions already open).",
        );
      }
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
      void vscode.window.showInformationMessage(onMessageText());
    } else if (choice === 'Not now') {
      await context.globalState.update(SETUP_KEY, 'off');
      pushState();
    }
  }

  function findSession(key: string): AgentSession | undefined {
    return engine.snapshot.sessions.find((s) => s.key === key);
  }

  /** "Go to agent": the session's terminal, the window that has its project, or its agent's panel. */
  async function goTo(s: AgentSession): Promise<void> {
    const result = await goToAgent(s, jumpDeps);
    log.info(`Go to agent: ${s.agent} ${s.id} → ${result}`);
    if (result !== 'none') return;
    const transcript = s.sources[0] && !/\.db$/i.test(s.sources[0]) ? 'Open transcript' : undefined;
    const resumable = canResume(s) ? 'Resume here' : undefined;
    const openProject = s.projectPath && !roots().some((r) => pathWithin(s.projectPath, r)) ? 'Open project' : undefined;
    const where = s.host === 'app' ? 'It runs in another app.' : 'It may run in another terminal app or window.';
    const choice = await vscode.window.showInformationMessage(
      `Kvali could not find where this ${s.agentLabel} session runs. ${where}`,
      ...[resumable, openProject, transcript].filter((x): x is string => !!x),
    );
    if (choice === 'Open transcript') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(s.sources[0]!));
    else if (choice === 'Resume here') resume(s);
    else if (choice === 'Open project') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.projectPath!), { forceNewWindow: true });
  }

  function canResume(s: AgentSession): boolean {
    return (s.agent === 'claude-code' || s.agent === 'codex') && SAFE_ID.test(s.id) && s.status !== 'working' && s.status !== 'waiting';
  }

  function resume(s: AgentSession): void {
    if (!SAFE_ID.test(s.id)) return;
    const cmd = s.agent === 'claude-code' ? `claude --resume ${s.id}` : s.agent === 'codex' ? `codex resume ${s.id}` : undefined;
    if (!cmd) return;
    const term = vscode.window.createTerminal({ name: `${s.agentLabel}: ${s.title.slice(0, 30)}`, cwd: s.cwd ?? s.projectPath });
    term.show();
    term.sendText(cmd);
  }

  const STATUS_ICON: Record<AgentSession['status'], string> = {
    waiting: '$(bell-dot)',
    error: '$(error)',
    working: '$(sync)',
    stale: '$(clock)',
    idle: '$(circle-outline)',
    done: '$(pass)',
  };

  /** "Kvali: Go to Agent…": the live sessions, the ones that need you first. */
  async function pickAndGoTo(): Promise<void> {
    const order: Record<string, number> = { waiting: 0, error: 1, working: 2, stale: 3, idle: 4, done: 5 };
    const live = engine.snapshot.sessions
      .filter((s) => s.agent !== 'progress-file' && s.agent !== 'antigravity')
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.updatedAt - a.updatedAt)
      .slice(0, 30);
    if (!live.length) {
      void vscode.window.showInformationMessage('Kvali: no agent sessions to go to.');
      return;
    }
    const item = await vscode.window.showQuickPick(
      live.map((s) => ({
        label: `${STATUS_ICON[s.status]} ${s.title}`,
        description: `${s.agentLabel} · ${projectName(s.projectPath)}`,
        detail: s.statusDetail,
        key: s.key,
      })),
      { placeHolder: 'Go to which agent?', matchOnDescription: true },
    );
    const s = item && findSession(item.key);
    if (s) await goTo(s);
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
      snap.errors.length ? `Errors:\n${snap.errors.map((e) => `- ${e.agent}: ${redactPaths(e.message)}`).join('\n')}` : 'Errors: none',
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
        if (await turnOn()) void vscode.window.showInformationMessage(onMessageText());
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
        if (s) resume(s);
        return;
      }
      case 'goto': {
        const s = findSession(m.key);
        if (s) await goTo(s);
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
      case 'showPhoneCard':
        phoneCard = true;
        pushState();
        return;
      case 'phoneEvents': {
        // What the phone hears about, chosen in the panel.
        const cfg = await readPhoneConfig(home);
        if (!cfg || !Array.isArray(m.events)) return;
        const events = PHONE_EVENTS.filter((e) => m.events.includes(e));
        const doneAfterSec = DONE_AFTER_CHOICES.includes(m.doneAfterSec) ? m.doneAfterSec : (cfg.doneAfterSec ?? DEFAULT_DONE_AFTER_SEC);
        await writePhoneConfig(home, { ...cfg, events, doneAfterSec });
        await phone.reload(true);
        pushState();
        return;
      }
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
      void vscode.window.showInformationMessage('Phone notifications are off (ntfy, Telegram and Discord). You can remove the Kvali topic from the ntfy app too.');
    }),
    vscode.commands.registerCommand('kvali.shareWeek', () => shareWeek()),
    vscode.commands.registerCommand('kvali.goToAgent', () => pickAndGoTo()),
    vscode.commands.registerCommand('kvali.telegramSetup', () => telegramSetup()),
    vscode.commands.registerCommand('kvali.discordSetup', () => discordSetup()),
    vscode.commands.registerCommand('kvali.telegramOff', () => channelOff('telegram')),
    vscode.commands.registerCommand('kvali.discordOff', () => channelOff('discord')),

    vscode.commands.registerCommand('kvali.setup', async () => {
      detected = await detectAgents(home, process.env);
      const changes = setupChanges(detected);
      if (!changes.length) {
        void vscode.window.showWarningMessage('Kvali found no agent it can set up here (Claude Code, Codex, Gemini CLI or Antigravity). Copilot, Cline, Roo Code, Kilo Code and OpenCode need no setup.');
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
      if (ok === 'Turn on' && (await turnOn())) void vscode.window.showInformationMessage(onMessageText());
    }),

    vscode.commands.registerCommand('kvali.turnOff', async () => {
      await removeSetup(home, process.env, { claudeExtensionDirs: setupOptions().claudeExtensionDirs });
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
      // Automatic plans also switch Claude Code's task-list tools, which setup manages.
      if (before.autoPlan !== config.autoPlan) void shareSettings().then(() => repairSetup());
      engine.configure({
        activeWindowMs: config.activeWindowHours * 3_600_000,
        staleAfterMs: config.staleAfterMinutes * 60_000,
        intervalMs: config.pollIntervalMs,
        pricing: new Pricing(config.pricing),
        disabled: config.disabled,
      });
      if (JSON.stringify(before.brainDirs) !== JSON.stringify(config.brainDirs)) {
        engine.setAdapters(createDefaultAdapters({ extraAntigravityBrainDirs: config.brainDirs, extraEditorStorageDirs: editorStorage }));
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
    { dispose: () => phone.dispose() },
  );

  // Time-based labels in the status bar ("done" fades after 30 minutes).
  const clock = setInterval(refreshStatusBar, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(clock) });

  windows.start();
  // Another window asks this one to take the person to a session it has open.
  windows.listen((key) => {
    const s = findSession(key);
    if (s) void jumpHere(s, jumpDeps).then((r) => log.info(`Go to agent (asked by another window): ${s.agent} ${s.id} → ${r}`));
  });
  hub.start();
  engine.start();
  phone.start();
  refreshStatusBar();
  void repairSetup().then(() => offerSetup());
  log.info(`Kvali started (home ${home}, ${roots().length} workspace folder(s))`);

  return {
    getSnapshot: () => engine.snapshot,
    onDidChangeSnapshot: (listener) => new vscode.Disposable(engine.onSnapshot(listener)),
    goToAgent: async (key) => {
      const s = findSession(key);
      return s ? goToAgent(s, jumpDeps) : 'none';
    },
  };
}

export function deactivate(): void {}
