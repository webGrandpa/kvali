import { promises as fsp } from 'node:fs';

const CHUNK_BYTES = 1 << 20; // 1 MiB

export interface TailResult {
  /** The file changed since the previous call. */
  changed: boolean;
  /** The file shrank or was replaced, so it was re-read from the start. Reset your state. */
  reset: boolean;
  /** Number of complete lines consumed. */
  lines: number;
}

/**
 * Incrementally reads a JSONL file that another process keeps appending to.
 *
 * Only complete lines (terminated by `\n`) are consumed; a partially written
 * last line is left for the next call. Splitting on the newline byte is safe
 * for UTF-8 because 0x0A never occurs inside a multi-byte sequence.
 */
export class JsonlTail {
  private offset = 0;
  private size = -1;
  private mtimeMs = -1;
  private ino: number | undefined;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Byte offset of the first unconsumed byte. */
  get position(): number {
    return this.offset;
  }

  async read(onRecord: (record: unknown) => void, onReset?: () => void): Promise<TailResult> {
    let st;
    try {
      st = await fsp.stat(this.path);
    } catch {
      return { changed: false, reset: false, lines: 0 };
    }
    if (st.size === this.size && st.mtimeMs === this.mtimeMs && st.ino === this.ino) {
      return { changed: false, reset: false, lines: 0 };
    }
    let reset = false;
    if (st.size < this.offset || (this.ino !== undefined && st.ino !== this.ino)) {
      this.offset = 0;
      reset = true;
      onReset?.();
    }
    this.ino = st.ino;

    let lines = 0;
    const fh = await fsp.open(this.path, 'r');
    try {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      let pos = this.offset;
      let carry: Buffer = Buffer.alloc(0);
      while (pos < st.size) {
        const want = Math.min(chunk.length, st.size - pos);
        const { bytesRead } = await fh.read(chunk, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf(10, start)) !== -1) {
          const line = buf.toString('utf8', start, nl).trim();
          start = nl + 1;
          lines += 1;
          if (!line) continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            continue; // malformed line: skip, never crash the reader
          }
          onRecord(record);
        }
        // Copy: `chunk` is reused by the next read.
        carry = Buffer.from(buf.subarray(start));
      }
      this.offset = pos - carry.length;
    } finally {
      await fh.close();
    }
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return { changed: true, reset, lines };
  }
}
