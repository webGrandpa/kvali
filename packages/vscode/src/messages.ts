/** Messages exchanged between the extension host and the Agents webview. */
import type { HookStatus, Snapshot } from '@kvali/core/browser';

/** Phone notifications as the panel shows them (the access token never reaches the webview). */
export interface PhoneView {
  server: string;
  topic: string;
  /** `ntfy://` link that subscribes the ntfy app; the QR code encodes it. */
  link: string;
  events: string[];
  details: boolean;
}

export type Scope = 'all' | 'workspace';
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
  | { type: 'runSetup' }
  | { type: 'dismissSetup' }
  | { type: 'copy'; text: string }
  | { type: 'hidePhoneCard' }
  | { type: 'showPhoneCard' }
  | { type: 'phoneProgress'; on: boolean }
  | {
      type: 'command';
      command:
        | 'kvali.setup'
        | 'kvali.addProgressProtocol'
        | 'kvali.reportProblem'
        | 'kvali.refresh'
        | 'kvali.showLog'
        | 'kvali.phoneSetup'
        | 'kvali.phoneTest'
        | 'kvali.phoneOff';
    };
