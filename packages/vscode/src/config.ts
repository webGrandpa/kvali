import * as vscode from 'vscode';
import type { AgentId, ModelPrice } from '@kvali/core';
import type { Scope } from './messages.ts';

export interface KvaliConfig {
  scope: Scope;
  activeWindowHours: number;
  staleAfterMinutes: number;
  pollIntervalMs: number;
  statusBar: boolean;
  notifyFinish: boolean;
  notifyNeedsInput: boolean;
  notifySystem: boolean;
  showCost: boolean;
  autoPlan: boolean;
  pricing: Record<string, Partial<ModelPrice>>;
  disabled: AgentId[];
  brainDirs: string[];
  port: number;
}

export function readConfig(): KvaliConfig {
  const c = vscode.workspace.getConfiguration('kvali');
  return {
    scope: c.get<Scope>('scope', 'all') === 'workspace' ? 'workspace' : 'all',
    activeWindowHours: c.get<number>('activeWindowHours', 24),
    staleAfterMinutes: c.get<number>('staleAfterMinutes', 30),
    pollIntervalMs: c.get<number>('pollIntervalMs', 1500),
    statusBar: c.get<boolean>('statusBar.enabled', true),
    notifyFinish: c.get<boolean>('notifications.onFinish', true),
    notifyNeedsInput: c.get<boolean>('notifications.onNeedsInput', true),
    notifySystem: c.get<boolean>('notifications.system', true),
    showCost: c.get<boolean>('cost.show', true),
    autoPlan: c.get<boolean>('autoPlan', true),
    pricing: c.get<Record<string, Partial<ModelPrice>>>('pricing', {}),
    disabled: c.get<AgentId[]>('agents.disabled', []),
    brainDirs: c.get<string[]>('antigravity.brainDirs', []),
    port: c.get<number>('hooks.port', 47821),
  };
}
