/**
 * The universal "progress file" protocol (see docs/PROTOCOL.md).
 *
 * Any agent that can edit files — Cursor, Copilot, Windsurf, Cline, Aider, … — can
 * report progress by keeping a markdown checklist at one of:
 *
 *   <workspace>/.agents/progress.md
 *   <workspace>/.agents/progress/<anything>.md     (one file per concurrent agent)
 *
 * Optional front matter: `agent`, `title`, `status` (working | waiting | blocked | done | idle | error), `model`.
 * The `kvali.addProgressProtocol` command adds the instructions to AGENTS.md.
 */
import { promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { staleness } from '../adapter.ts';
import { pathWithin } from '../format.ts';
import type { AgentSession, SessionStatus } from '../model.ts';
import { progressOf } from '../model.ts';
import { parseChecklist } from '../util/checklist.ts';
import { listDir, readTextSafe, statSafe } from '../util/fs.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { basename, lookupTable, truncate } from '../util/text.ts';

// No prototype: `status: constructor` in a repository's file is not a status.
const STATUS_WORDS = lookupTable<SessionStatus>({
  working: 'working',
  running: 'working',
  in_progress: 'working',
  waiting: 'waiting',
  blocked: 'waiting',
  needs_input: 'waiting',
  done: 'done',
  completed: 'done',
  idle: 'idle',
  paused: 'idle',
  error: 'error',
  failed: 'error',
});

/** Progress files read per workspace, the most recently written first: one per agent, not a folder of thousands. */
export const MAX_PROGRESS_FILES = 20;
/** Names looked at in `.agents/progress/`, a bound on the work a large folder can make. */
const MAX_LISTED = 500;

async function realpathSafe(p: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(p);
  } catch {
    return undefined;
  }
}

export class ProgressFileAdapter implements Adapter {
  readonly id = 'progress-file';
  readonly label = 'Progress file';

  private readonly cache = new Map<string, { mtimeMs: number; session: AgentSession }>();
  private readonly timers = new Map<string, TaskTimer>();

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const files: { file: string; root: string; st: Stats }[] = [];
    for (const root of ctx.workspaceRoots) {
      const agentsDir = path.join(root, '.agents');
      const names = [path.join(agentsDir, 'progress.md')];
      for (const f of (await listDir(path.join(agentsDir, 'progress'))).slice(0, MAX_LISTED)) {
        if (f.isFile() && f.name.endsWith('.md')) names.push(path.join(agentsDir, 'progress', f.name));
      }
      const realRoot = await realpathSafe(root);
      if (!realRoot) continue;
      const found: { file: string; root: string; st: Stats }[] = [];
      for (const file of names) {
        const st = await statSafe(file);
        if (!st || !st.isFile()) continue;
        // A link to a file outside the workspace (a key, your notes) is not the workspace's progress.
        const real = await realpathSafe(file);
        if (!real || !pathWithin(real, realRoot)) continue;
        found.push({ file, root, st });
      }
      found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      files.push(...found.slice(0, MAX_PROGRESS_FILES));
    }

    const out: AgentSession[] = [];
    const seen = new Set<string>();
    for (const { file, root, st } of files) {
      seen.add(file);
      let entry = this.cache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        const md = await readTextSafe(file, 1 << 20);
        if (md === undefined) continue;
        const session = this.build(file, root, md, st.mtimeMs, st.birthtimeMs);
        const timer = this.timers.get(file) ?? new TaskTimer();
        this.timers.set(file, timer);
        timer.observe(session.tasks, st.mtimeMs);
        session.current = timer.current(session.tasks);
        entry = { mtimeMs: st.mtimeMs, session };
        this.cache.set(file, entry);
      }
      if (ctx.now() - entry.mtimeMs > ctx.activeWindowMs) continue;
      out.push(this.withStaleness(entry.session, ctx));
    }
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    return out;
  }

  private build(file: string, workspace: string, md: string, mtimeMs: number, birthtimeMs: number): AgentSession {
    const parsed = parseChecklist(md);
    const fm = parsed.frontmatter;
    const prog = progressOf(parsed.tasks);
    const declared = fm.status ? STATUS_WORDS[fm.status.toLowerCase().replace(/[\s-]+/g, '_')] : undefined;
    const current = parsed.tasks.find((t) => t.status === 'in_progress');
    let status: SessionStatus;
    if (declared) status = declared;
    else if (prog.total > 0 && prog.done === prog.total) status = 'done';
    else if (current) status = 'working';
    else status = 'idle';

    const agentName = fm.agent?.trim();
    return {
      key: `progress-file:${file}`,
      agent: 'progress-file',
      agentLabel: agentName || 'Agent',
      id: file,
      title: truncate(parsed.title || fm.title || basename(file).replace(/\.md$/, ''), 100),
      projectPath: workspace,
      model: fm.model,
      status,
      statusDetail: fm.status && status === 'waiting' ? fm.note || 'Waiting for you' : undefined,
      startedAt: Math.min(birthtimeMs || mtimeMs, mtimeMs),
      updatedAt: mtimeMs,
      tasks: parsed.tasks,
      activity: current
        ? { kind: 'other', label: truncate(current.activeTitle ?? current.title, 80), startedAt: mtimeMs }
        : undefined,
      sources: [file],
    };
  }

  private withStaleness(s: AgentSession, ctx: AdapterContext): AgentSession {
    if (s.status !== 'working') return s;
    const stale = staleness(s.updatedAt, ctx);
    return stale ? { ...s, status: 'stale', statusDetail: stale, activity: undefined } : s;
  }
}
