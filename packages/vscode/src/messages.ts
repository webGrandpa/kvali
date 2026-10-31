/** Messages exchanged between the extension host and the Agents webview. */
import type { HookStatus, Snapshot } from '@kvali/core/browser';

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
  setup: SetupState;
  /** Agents found on this machine, e.g. ["Claude Code", "Antigravity"]. */
  detected: string[];
  /** What turning setup on changes, one line per agent. */
  setupChanges: string[];
  /** `true` when this window owns the hook port. */
  isHub: boolean;
  activeWindowHours: number;
  home: string;
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'setScope'; scope: Scope }
  | { type: 'open'; key: string }
  | { type: 'resume'; key: string }
  | { type: 'runSetup' }
  | { type: 'dismissSetup' }
  | {
      type: 'command';
      command: 'kvali.setup' | 'kvali.addProgressProtocol' | 'kvali.reportProblem' | 'kvali.refresh' | 'kvali.showLog';
    };
