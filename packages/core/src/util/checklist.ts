import type { TaskItem, TaskStatus } from '../model.ts';

export interface ParsedChecklist {
  title?: string;
  frontmatter: Record<string, string>;
  tasks: TaskItem[];
}

// Written so that no line can make them slow: no two quantifiers that can match the same text.
const ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX/\-~>!?])\][ \t]+(\S.*)$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** Longer lines are cut before they are read: no title needs more, and a file cannot slow Kvali down. */
const MAX_LINE = 2_000;
/** A plan longer than this is a file that is not one. */
const MAX_TASKS = 500;

/** A markdown heading ("## Title", "## Title ##") as its level and text, read without a regex. */
function heading(line: string): [number, string] | undefined {
  let level = 0;
  while (level < line.length && line[level] === '#') level += 1;
  if (level < 1 || level > 6) return undefined;
  const rest = line.slice(level);
  if (rest !== '' && rest[0] !== ' ' && rest[0] !== '\t') return undefined;
  let text = rest.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  // A closing run of #s counts only after a space ("## C#" keeps its #).
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trimEnd();
  return text ? [level, text] : undefined;
}

const MARKER_STATUS: Record<string, TaskStatus> = {
  ' ': 'pending',
  x: 'completed',
  X: 'completed',
  '/': 'in_progress',
  '>': 'in_progress',
  '-': 'cancelled',
  '~': 'cancelled',
  '!': 'blocked',
  '?': 'blocked',
};

/**
 * Parses a markdown checklist such as an Antigravity `task.md` or a
 * `.agents/progress.md` written under the Kvali progress protocol.
 *
 *   - [ ] pending      - [/] in progress    - [x] done
 *   - [-] cancelled    - [!] blocked
 */
export function parseChecklist(markdown: string): ParsedChecklist {
  const frontmatter: Record<string, string> = Object.create(null) as Record<string, string>;
  let body = markdown.replace(/^\ufeff/, '');

  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of body.slice(3, end).split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const key = line.slice(0, colon).trim();
        if (!KEY_RE.test(key)) continue;
        frontmatter[key.toLowerCase()] = line.slice(colon + 1, colon + 1 + MAX_LINE).trim().replace(/^["']|["']$/g, '');
      }
      body = body.slice(end + 4);
    }
  }

  let title: string | undefined;
  let group: string | undefined;
  const tasks: TaskItem[] = [];
  let inFence = false;

  for (const raw of body.split('\n')) {
    if (tasks.length >= MAX_TASKS) break;
    const line = (raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw).replace(/\r$/, '');
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = heading(line);
    if (h) {
      const [level, text] = h;
      if (level === 1 && title === undefined) title = text;
      else group = text;
      continue;
    }

    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    tasks.push({
      id: String(tasks.length + 1),
      title: m[3].trimEnd(),
      status: MARKER_STATUS[m[2]] ?? 'pending',
      depth: Math.floor(indent / 2),
      group,
    });
  }

  return { title: frontmatter.title || title, frontmatter, tasks };
}
