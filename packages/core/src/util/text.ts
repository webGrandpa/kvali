/** First non-empty line of `text`, whitespace-collapsed and truncated to `max` characters. */
export function firstLine(text: string, max = 80): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return truncate(line.replace(/\s+/g, ' '), max);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

const INJECTED_TAGS = ['system-reminder', 'local-command-stdout', 'local-command-stderr', 'command-message', 'command-args'];

/** `text` without each `<tag>…</tag>` (or with only what is inside, `keep`). Scans once: no slow cases. */
function removeTagged(text: string, tag: string, keep: boolean): string {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  let out = '';
  let pos = 0;
  for (;;) {
    const a = text.indexOf(open, pos);
    if (a === -1) break;
    const b = text.indexOf(close, a + open.length);
    if (b === -1) break; // never closed: the rest stays as it is
    out += text.slice(pos, a) + (keep ? text.slice(a + open.length, b) : '');
    pos = b + close.length;
  }
  return out + text.slice(pos);
}

/** Removes XML-ish wrapper tags that agents inject into user turns (system reminders, command output). */
export function stripInjectedTags(text: string): string {
  let out = text;
  for (const tag of INJECTED_TAGS) out = removeTagged(out, tag, false);
  return removeTagged(out, 'command-name', true).trim();
}

/** Extracts plain text from Anthropic/Gemini-style content: a string, or an array of `{type:'text', text}` / `{text}` parts. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string' && (p.type === undefined || p.type === 'text' || p.type === 'input_text' || p.type === 'output_text')) {
        parts.push(p.text);
      }
    }
  }
  return parts.join('\n');
}

/** A compact one-line summary of a shell command. */
export function summarizeCommand(cmd: unknown, max = 80): string | undefined {
  let text: string | undefined;
  if (typeof cmd === 'string') text = cmd;
  else if (Array.isArray(cmd)) {
    const parts = cmd.filter((c): c is string => typeof c === 'string');
    // ["bash", "-lc", "pnpm test"] -> "pnpm test"
    if (parts.length >= 3 && /(^|\/)(ba|z|fi)?sh$/.test(parts[0]) && /^-\w*c$/.test(parts[1])) text = parts.slice(2).join(' ');
    else text = parts.join(' ');
  }
  if (!text) return undefined;
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * A lookup table keyed by names from agents' files: without a prototype, so a name such as
 * "constructor" or "valueOf" is simply not in it.
 */
export function lookupTable<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

// Terminal escape sequences: CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), any other ESC + one character.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
// Control characters but tab and newline (a carriage return can redraw a terminal line), DEL,
// C1 controls, bidi overrides and isolates, zero-width characters, the line/paragraph separators.
const INVISIBLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Text from an agent's or a repository's file made safe to show in a terminal, a notification
 * or a card: no escape sequences a terminal would act on (write the clipboard, clear the
 * screen, retitle the window), no control or invisible characters, no bidi overrides that make
 * text read differently from what it is; at most `max` characters. Ordinary text is unchanged.
 */
export function cleanText(text: string, max = 1_000): string {
  const t = text.replace(ESCAPES, '').replace(INVISIBLE, '');
  return t.length > max ? truncate(t, max) : t;
}

/** `o` with the named string fields cleaned (see cleanText); the same object when nothing changed. */
export function cleanFields<T extends object>(o: T, fields: Partial<Record<keyof T & string, number>>): T {
  let out: T | undefined;
  for (const [k, max] of Object.entries(fields) as [keyof T & string, number][]) {
    const v = o[k];
    if (typeof v !== 'string') continue;
    const c = cleanText(v, max);
    if (c !== v) {
      out ??= { ...o };
      (out as Record<string, unknown>)[k] = c;
    }
  }
  return out ?? o;
}

/**
 * A readable message from an error as an agent recorded it: a string, an Error-like object, or
 * an API error body with its `error` nested inside. Never "[object Object]".
 */
export function errorMessage(v: unknown, depth = 0): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (!v || typeof v !== 'object' || depth > 4) return undefined;
  const o = v as Record<string, unknown>;
  const inner = errorMessage(o.message, depth + 1) ?? errorMessage(o.error, depth + 1) ?? errorMessage(o.data, depth + 1) ?? errorMessage(o.cause, depth + 1);
  const status = typeof o.status === 'number' ? o.status : undefined;
  if (inner) return status && !inner.includes(String(status)) ? `${inner} (${status})` : inner;
  if (typeof o.type === 'string' && o.type !== 'error') return o.type;
  return status ? `API error ${status}` : undefined;
}
