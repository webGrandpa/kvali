import { existsSync, promises as fsp, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';

export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function statSafe(p: string): Promise<Stats | undefined> {
  try {
    return await fsp.stat(p);
  } catch {
    return undefined;
  }
}

export async function readTextSafe(p: string, maxBytes = 4 << 20): Promise<string | undefined> {
  try {
    const st = await fsp.stat(p);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return await fsp.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

export async function readJsonSafe<T = unknown>(p: string, maxBytes = 4 << 20): Promise<T | undefined> {
  const text = await readTextSafe(p, maxBytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

const rootCache = new Map<string, string | undefined>();

/**
 * Walks up from `p` to the nearest directory that contains `.git`.
 * Results are cached per directory. Returns `undefined` when no repository is found.
 */
export function findGitRoot(p: string, maxLevels = 12): string | undefined {
  let dir = path.resolve(p);
  const visited: string[] = [];
  for (let i = 0; i < maxLevels; i += 1) {
    if (rootCache.has(dir)) {
      const hit = rootCache.get(dir);
      for (const v of visited) rootCache.set(v, hit);
      return hit;
    }
    visited.push(dir);
    if (existsSync(path.join(dir, '.git'))) {
      for (const v of visited) rootCache.set(v, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const v of visited) rootCache.set(v, undefined);
  return undefined;
}

/** True when `child` equals `parent` or lives inside it. */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
