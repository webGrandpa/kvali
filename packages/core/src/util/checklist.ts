import type { TaskItem, TaskStatus } from '../model.ts';

export interface ParsedChecklist {
  title?: string;
  frontmatter: Record<string, string>;
  tasks: TaskItem[];
}

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX/\-~>!?])\]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

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
  const frontmatter: Record<string, string> = {};
  let body = markdown.replace(/^﻿/, '');

  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of body.slice(3, end).split('\n')) {
        const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (m) frontmatter[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '');
      }
      body = body.slice(end + 4);
    }
  }

  let title: string | undefined;
  let group: string | undefined;
  const tasks: TaskItem[] = [];
  let inFence = false;

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h = HEADING_RE.exec(line);
    if (h) {
      const text = h[2].trim();
      if (h[1].length === 1 && title === undefined) title = text;
      else group = text;
      continue;
    }

    const m = ITEM_RE.exec(line);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    tasks.push({
      id: String(tasks.length + 1),
      title: m[3],
      status: MARKER_STATUS[m[2]] ?? 'pending',
      depth: Math.floor(indent / 2),
      group,
    });
  }

  return { title: frontmatter.title || title, frontmatter, tasks };
}
