import { promises as fsp } from 'node:fs';

const CHUNK_BYTES = 1 << 20; // 1 MiB
/**
 * A longer line is skipped, not held in memory: no record Kvali reads is this big, while a
 * pasted log or an image in a transcript can be.
 */
export const MAX_LINE_BYTES = 8 << 20; // 8 MiB

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
  /** Inside a line longer than MAX_LINE_BYTES: skipping to its end. */
  private skipping = false;
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

  /** When the file was last modified, as of the last read (-1 before the first). */
  get modifiedAt(): number {
    return this.mtimeMs;
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
      this.skipping = false;
      reset = true;
      onReset?.();
    }
    this.ino = st.ino;

    let lines = 0;
    const fh = await fsp.open(this.path, 'r');
    try {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      let pos = this.offset;
      // The line not finished yet, in pieces: joined once, at its newline (no copying it over and over).
      let parts: Buffer[] = [];
      let partsLen = 0;
      let skipping = this.skipping;
      while (pos < st.size) {
        const want = Math.min(chunk.length, st.size - pos);
        const { bytesRead } = await fh.read(chunk, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const buf = chunk.subarray(0, bytesRead);
        let start = 0;
        let nl: number;
        while ((nl = buf.indexOf(10, start)) !== -1) {
          lines += 1;
          const piece = buf.subarray(start, nl);
          start = nl + 1;
          if (skipping) {
            skipping = false; // the end of a line too long to read
            continue;
          }
          if (partsLen + piece.length > MAX_LINE_BYTES) {
            parts = [];
            partsLen = 0;
            continue;
          }
          const line = (partsLen ? Buffer.concat([...parts, piece]) : piece).toString('utf8').trim();
          parts = [];
          partsLen = 0;
          if (!line) continue;
          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch {
            continue; // malformed line: skip, never crash the reader
          }
          try {
            onRecord(record);
          } catch {
            // A record its reader cannot take (an odd value where text was expected) is skipped:
            // the reader moves on, so one line never hides the rest of the file.
          }
        }
        if (!skipping && start < buf.length) {
          if (partsLen + (buf.length - start) > MAX_LINE_BYTES) {
            skipping = true;
            parts = [];
            partsLen = 0;
          } else {
            parts.push(Buffer.from(buf.subarray(start))); // a copy: `chunk` is reused by the next read
            partsLen += buf.length - start;
          }
        }
      }
      this.skipping = skipping;
      this.offset = pos - partsLen;
    } finally {
      await fh.close();
    }
    this.size = st.size;
    this.mtimeMs = st.mtimeMs;
    return { changed: true, reset, lines };
  }
}
