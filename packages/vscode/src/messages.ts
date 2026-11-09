/** Messages exchanged between the extension host and the Agents webview. */
import type { HookStatus, Snapshot } from '@kvali/core/browser';

/** Phone notifications as the panel shows them (tokens and webhooks never reach the webview). */
export interface PhoneView {
  server: string;
  /** The ntfy topic, when ntfy is set up. */
  topic?: string;
  /** `ntfy://` link that subscribes the ntfy app; the QR code encodes it. */
  link?: string;
  /** Telegram is set up: the bot's name. */
  telegram?: { bot?: string };
  /** Discord is set up. */
  discord: boolean;
  events: string[];
  details: boolean;
  /** A task's end is pushed when it took at least this many seconds (0: every task). */
  doneAfterSec: number;
}

export type Scope = 'all' | 'workspace';

/** The weekly card's two sizes: wide for links and X, tall for LinkedIn and Instagram feeds. */
export type ShareFormat = 'landscape' | 'portrait';

/** Messages from the "Share your week" panel. */
export type FromShare =
  | { type: 'ready' }
  | { type: 'save'; dataUrl: string; format: ShareFormat }
  | { type: 'copyText'; text: string }
  | { type: 'copyFailed' }
  | { type: 'open'; url: string };
/** `unset` until the user answers the one-time setup offer. */
export type SetupState = 'on' | 'off' | 'unset';

export interface ViewState {
  type: 'state';
  snapshot: Snapshot;
  workspaceRoots: string[];
  scope: Scope;
  showCost: boolean;
  claudeHooks: HookStatus;
  /** How Claude Code is connected: Kvali's plugin, its hooks (older Claude Code), or not at all. */
  claudeMode: 'plugin' | 'hooks' | 'none';
  setup: SetupState;
  /** Agents found on this machine, e.g. ["Claude Code", "Antigravity"]. */
  detected: string[];
  /** What turning setup on changes, one line per agent. */
  setupChanges: string[];
  /** `true` when this window owns the hook port. */
  isHub: boolean;
  activeWindowHours: number;
  home: string;
  /** Phone notifications, when set up. */
  phone?: PhoneView;
  /** Show the phone card (after setup, or when asked). */
  phoneCard: boolean;
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'setScope'; scope: Scope }
  | { type: 'open'; key: string }
  | { type: 'resume'; key: string }
  | { type: 'goto'; key: string }
  | { type: 'runSetup' }
  | { type: 'dismissSetup' }
  | { type: 'copy'; text: string }
  | { type: 'hidePhoneCard' }
  | { type: 'showPhoneCard' }
  | { type: 'phoneEvents'; events: string[]; doneAfterSec: number }
  | { type: 'command'; command: WebviewCommand };

/** The commands the panel's buttons run. */
export const WEBVIEW_COMMANDS = [
  'kvali.setup',
  'kvali.addProgressProtocol',
  'kvali.reportProblem',
  'kvali.refresh',
  'kvali.showLog',
  'kvali.phoneSetup',
  'kvali.phoneTest',
  'kvali.phoneOff',
  'kvali.telegramSetup',
  'kvali.discordSetup',
  'kvali.telegramOff',
  'kvali.discordOff',
  'kvali.shareWeek',
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export function isWebviewCommand(c: unknown): c is WebviewCommand {
  return typeof c === 'string' && (WEBVIEW_COMMANDS as readonly string[]).includes(c);
}
