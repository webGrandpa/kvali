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

/** Removes XML-ish wrapper tags that agents inject into user turns (system reminders, command output). */
export function stripInjectedTags(text: string): string {
  return text
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .trim();
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
