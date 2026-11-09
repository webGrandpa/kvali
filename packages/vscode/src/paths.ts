/**
 * Paths and ids that come from agents' files, checked before the editor acts on them: opens a
 * folder, starts a terminal in it, or hands an id to a command.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** A session id that is safe to put in a command line or hand to another extension. */
export const SAFE_ID = /^[A-Za-z0-9-]{8,80}$/;

/** `\\server\share` or `//server/share`: opening one makes Windows sign in to that server. */
export function isNetworkPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

async function existing(p: string | undefined, kind: 'dir' | 'file'): Promise<string | undefined> {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p) || isNetworkPath(p)) return undefined;
  try {
    const st = await fsp.stat(p);
    return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** A folder Kvali may open or start a terminal in: a full local path to a folder that exists. */
export function safeFolder(p: string | undefined): Promise<string | undefined> {
  return existing(p, 'dir');
}

/** A file Kvali may open: a full local path to a file that exists. */
export function safeFile(p: string | undefined): Promise<string | undefined> {
  return existing(p, 'file');
}

/** A folder a window may claim: a full local path, not a drive's or the disk's root (that would claim every project). */
export function isWorkspaceRoot(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && !isNetworkPath(p) && path.dirname(p) !== p;
}
