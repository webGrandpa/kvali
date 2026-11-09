import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';

/**
 * Writes a file so that a crash or a full disk never leaves it half written: the text goes to
 * a temporary file beside it, which then replaces it in one step. The file keeps its
 * permissions; a new one gets `mode` (default 0644 before the umask). A symbolic link (a
 * dotfiles setup) is written through instead, so it stays a link.
 */
export async function writeFileSafely(file: string, text: string, mode?: number): Promise<void> {
  let current: { link: boolean; mode: number } | undefined;
  try {
    const st = await fsp.lstat(file);
    current = { link: st.isSymbolicLink(), mode: st.mode & 0o777 };
  } catch {
    // a new file
  }
  if (current?.link) {
    await fsp.writeFile(file, text);
    return;
  }
  const tmp = `${file}.kvali-${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode: mode ?? current?.mode ?? 0o644, flag: 'wx' });
    if (current) await fsp.chmod(tmp, mode ?? current.mode);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** `text` without the line breaks at its end. A loop, not a regex: no slow cases. */
export function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end -= 1;
  return text.slice(0, end);
}

/** `text` without the line breaks at its start. */
export function trimLeadingNewlines(text: string): string {
  let start = 0;
  while (start < text.length && (text[start] === '\n' || text[start] === '\r')) start += 1;
  return text.slice(start);
}
