/** Messages exchanged between the extension host and the Agents webview. */
import type { HookStatus, Snapshot } from '@kvali/core/browser';

export type Scope = 'all' | 'workspace';

export interface ViewState {
  type: 'state';
  snapshot: Snapshot;
  workspaceRoots: string[];
  scope: Scope;
  showCost: boolean;
  claudeHooks: HookStatus;
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
  | { type: 'command'; command: 'kvali.installClaudeHooks' | 'kvali.addProgressProtocol' | 'kvali.refresh' | 'kvali.showLog' };
