import path from 'node:path';
import * as vscode from 'vscode';
import type { AgentId, ModelPrice } from '@kvali/core';
import { DEFAULT_HOOK_PORT } from '@kvali/core';
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

/** A number setting within its bounds; anything else (a string, NaN) is the default. */
export function boundedNumber(v: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  if (integer && !Number.isInteger(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function readConfig(): KvaliConfig {
  const c = vscode.workspace.getConfiguration('kvali');
  const pricing = c.get<unknown>('pricing', {});
  return {
    scope: c.get<Scope>('scope', 'all') === 'workspace' ? 'workspace' : 'all',
    activeWindowHours: boundedNumber(c.get('activeWindowHours'), 24, 1, 720),
    staleAfterMinutes: boundedNumber(c.get('staleAfterMinutes'), 30, 5, 10_080),
    pollIntervalMs: boundedNumber(c.get('pollIntervalMs'), 1500, 500, 30_000),
    statusBar: c.get<boolean>('statusBar.enabled', true),
    notifyFinish: c.get<boolean>('notifications.onFinish', true),
    notifyNeedsInput: c.get<boolean>('notifications.onNeedsInput', true),
    notifySystem: c.get<boolean>('notifications.system', true),
    showCost: c.get<boolean>('cost.show', true),
    autoPlan: c.get<boolean>('autoPlan', true),
    pricing: pricing && typeof pricing === 'object' && !Array.isArray(pricing) ? (pricing as Record<string, Partial<ModelPrice>>) : {},
    disabled: strings(c.get('agents.disabled')) as AgentId[],
    // Folders to read Antigravity's plans from: full paths only, never "/" itself.
    brainDirs: strings(c.get('antigravity.brainDirs')).filter((d) => path.isAbsolute(d) && path.dirname(d) !== d),
    port: boundedNumber(c.get('hooks.port'), DEFAULT_HOOK_PORT, 1024, 65_535, true),
  };
}
