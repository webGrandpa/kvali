/**
 * Read-only SQLite for the agents that keep their sessions in a database (OpenCode, Kilo Code,
 * Copilot's per-session todo lists), through the runtime's built-in `node:sqlite`.
 *
 * It is there in Node 22.13 and later and in the editors that run on it (VS Code 1.10x and
 * the editors built on it). Elsewhere `openReadOnly` returns `undefined`, and the adapters that
 * need it report nothing rather than fail. Kvali only ever reads: connections are opened
 * read-only, and every statement runs and finishes inside one poll, so the agent writing the
 * database is never blocked.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');

let loaded: SqliteModule | null | undefined;

/** `node:sqlite`, or `null` when this runtime does not have it. Its "experimental" warning is not printed. */
export function sqliteModule(): SqliteModule | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  // `readOnly` connections need Node 22.12; before 22.13 the module also needed a flag.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) return loaded;
  const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof get !== 'function') return loaded;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && /sqlite/i.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = get.call(process, 'node:sqlite') as SqliteModule | undefined;
    if (mod && typeof mod.DatabaseSync === 'function') loaded = mod;
  } catch {
    loaded = null;
  } finally {
    process.emitWarning = emit;
  }
  return loaded;
}

export type Row = Record<string, unknown>;

/** A read-only connection with cached statements. Every call swallows errors and returns nothing. */
export class ReadOnlyDb {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private lastDataVersion: number | undefined;

  private constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.db = db;
  }

  static open(file: string): ReadOnlyDb | undefined {
    const mod = sqliteModule();
    if (!mod) return undefined;
    try {
      const db = new mod.DatabaseSync(file, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 1000');
      } catch {
        /* older SQLite builds: the default is fine */
      }
      return new ReadOnlyDb(file, db);
    } catch {
      return undefined;
    }
  }

  all(sql: string, ...params: (string | number | null)[]): Row[] {
    try {
      return this.statement(sql).all(...params) as Row[];
    } catch {
      return [];
    }
  }

  get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    try {
      return this.statement(sql).get(...params) as Row | undefined;
    } catch {
      return undefined;
    }
  }

  /** Table name → its columns, for the tables that exist. */
  schema(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const t of this.all("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const name = String(t.name);
      out.set(name, new Set(this.all(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).map((c) => String(c.name))));
    }
    return out;
  }

  /**
   * Whether another connection changed the database since the last call (`PRAGMA data_version`).
   * The first call says yes.
   */
  changed(): boolean {
    const v = Number(this.get('PRAGMA data_version')?.data_version);
    if (!Number.isFinite(v)) return true;
    const changed = v !== this.lastDataVersion;
    this.lastDataVersion = v;
    return changed;
  }

  close(): void {
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  private statement(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }
}
