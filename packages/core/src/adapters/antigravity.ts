/**
 * Google Antigravity agent adapter.
 *
 * Each conversation lives in <brain>/<conversation-id>/ where <brain> is
 * ~/.gemini/antigravity-ide/brain (current IDE) or ~/.gemini/antigravity/brain (older builds):
 *
 *   task.md                               the agent's task list (markdown checklist)
 *   task.md.metadata.json                 { artifactType, summary, updatedAt }
 *   .system_generated/logs/transcript.jsonl   one line per step:
 *       { step_index, source, type, status, created_at, content, tool_calls: [{ name, args }] }
 *
 * Tool call args are JSON-encoded strings and include a human readable `toolAction`
 * ("Running pnpm check-types"), which becomes the session's current activity.
 * Antigravity does not store token usage locally, so `tokens` stays undefined.
 */
import path from 'node:path';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { isolated } from '../adapter.ts';
import type { Activity, AgentSession, DailyUsage, TaskItem } from '../model.ts';
import { progressOf } from '../model.ts';
import { parseChecklist } from '../util/checklist.ts';
import { findGitRoot, isWithin, listDir, readJsonSafe, readTextSafe, statSafe } from '../util/fs.ts';
import { JsonlTail } from '../util/jsonl.ts';
import { errorMessage, firstLine, truncate } from '../util/text.ts';
import { TaskTimer } from '../util/task-timer.ts';
import { addTaskDone, addWork, parseTime } from '../util/time.ts';

const ASK_TOOLS = new Set(['ask_permission', 'ask_question', 'request_feedback', 'notify_user']);
const PATH_ARGS: Record<string, number> = {
  Cwd: 5,
  DirectoryPath: 2,
  SearchDirectory: 2,
  SearchPath: 1,
  AbsolutePath: 1,
  TargetFile: 1,
  File: 1,
};
/** A step that is not followed by anything for this long means the agent stopped. */
const PAUSED_AFTER_MS = 5 * 60_000;

interface Step {
  type: string;
  status: string;
  source: string;
  at: number;
  tools: string[];
}

interface AgState {
  id: string;
  dir: string;
  tail: JsonlTail;
  startedAt?: number;
  updatedAt: number;
  lastStep?: Step;
  activity?: Activity;
  pendingAsk?: string;
  firstInput?: string;
  model?: string;
  error?: string;
  votes: Map<string, number>;
  project?: string;
  projectVotesAt: number;
  task?: { mtimeMs: number; title?: string; tasks: TaskItem[]; summary?: string };
  steps: number;
  turnSteps: number;
  turnStartedAt?: number;
  timer: TaskTimer;
  recent: Activity[];
  /** Work time and finished steps per day (Antigravity records no tokens). */
  daily: Record<string, DailyUsage>;
  lastStepAt?: number;
}

function decodeArg(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('"') && !s.startsWith('{') && !s.startsWith('[')) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

function argmax(m: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestW = -1;
  for (const [k, w] of m) {
    // On a tie prefer the shorter path (a repository over one of its folders).
    if (w > bestW || (w === bestW && best !== undefined && k.length < best.length)) {
      best = k;
      bestW = w;
    }
  }
  return best;
}

function commonAncestor(dirs: string[]): string | undefined {
  if (!dirs.length) return undefined;
  const split = dirs.map((d) => d.split(path.sep));
  const first = split[0];
  let n = first.length;
  for (const parts of split) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i += 1;
    n = i;
  }
  const joined = first.slice(0, n).join(path.sep);
  return joined || undefined;
}

export function inferProject(votes: Map<string, number>, home?: string): string | undefined {
  if (votes.size === 0) return undefined;
  let total = 0;
  for (const w of votes.values()) total += w;

  const byGit = new Map<string, number>();
  let gitWeight = 0;
  for (const [dir, w] of votes) {
    const root = findGitRoot(dir);
    if (!root) continue;
    byGit.set(root, (byGit.get(root) ?? 0) + w);
    gitWeight += w;
  }
  if (gitWeight * 2 >= total) return argmax(byGit);

  // No repository: take the common ancestor of folders carrying ≥ 10% of the activity,
  // unless that collapses to something too generic such as the home directory.
  const strong = [...votes].filter(([, w]) => w * 10 >= total).map(([d]) => d);
  const anc = commonAncestor(strong);
  const tooGeneric =
    !anc ||
    anc.split(path.sep).filter(Boolean).length < 2 ||
    (home !== undefined && (isWithin(home, anc) || path.dirname(anc) === home));
  return tooGeneric ? argmax(votes) : anc;
}

function humanize(tool: string): string {
  const map: Record<string, string> = {
    view_file: 'Reading a file',
    list_dir: 'Listing a directory',
    grep_search: 'Searching code',
    run_command: 'Running a command',
    write_to_file: 'Writing a file',
    replace_file_content: 'Editing a file',
    multi_replace_file_content: 'Editing a file',
    search_web: 'Searching the web',
    invoke_subagent: 'Running subagents',
    browser_subagent: 'Using the browser',
  };
  return map[tool] ?? tool.replace(/_/g, ' ');
}

export class AntigravityAdapter implements Adapter {
  readonly id = 'antigravity';
  readonly label = 'Antigravity';

  private readonly tracked = new Map<string, AgState>();
  private lastDiscovery = 0;
  private readonly extraBrainDirs: readonly string[];

  constructor(extraBrainDirs: readonly string[] = []) {
    this.extraBrainDirs = extraBrainDirs;
  }

  brainDirs(ctx: AdapterContext): string[] {
    const g = path.join(ctx.home, '.gemini');
    return [path.join(g, 'antigravity-ide', 'brain'), path.join(g, 'antigravity', 'brain'), ...this.extraBrainDirs];
  }

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (this.tracked.size === 0 || now - this.lastDiscovery >= 5_000) {
      this.lastDiscovery = now;
      await this.discover(ctx);
    }
    const out: AgentSession[] = [];
    for (const st of this.tracked.values()) {
      const s = await isolated(ctx, `[antigravity] ${st.id}`, async () => {
        await st.tail.read(
          (rec) => this.onStep(st, rec, ctx),
          () => {
            Object.assign(st, this.blank(st.id, st.dir), { tail: st.tail });
          },
        );
        await this.readTask(st);
        return this.toSession(st, ctx);
      });
      if (s) out.push(s);
    }
    return out;
  }

  private blank(id: string, dir: string): AgState {
    const daily: Record<string, DailyUsage> = {};
    return {
      id,
      dir,
      tail: new JsonlTail(path.join(dir, '.system_generated', 'logs', 'transcript.jsonl')),
      updatedAt: 0,
      votes: new Map(),
      projectVotesAt: -1,
      steps: 0,
      turnSteps: 0,
      timer: new TaskTimer((at) => addTaskDone(daily, at)),
      recent: [],
      daily,
    };
  }

  private async discover(ctx: AdapterContext): Promise<void> {
    const now = ctx.now();
    const found: { dir: string; id: string; mtimeMs: number }[] = [];
    for (const brain of this.brainDirs(ctx)) {
      for (const d of await listDir(brain)) {
        if (!d.isDirectory() || !/^[0-9a-f-]{36}$/i.test(d.name)) continue;
        const dir = path.join(brain, d.name);
        const stats = await Promise.all([
          statSafe(path.join(dir, '.system_generated', 'logs', 'transcript.jsonl')),
          statSafe(path.join(dir, 'task.md')),
        ]);
        const mtimeMs = Math.max(...stats.map((s) => s?.mtimeMs ?? 0));
        if (mtimeMs && now - mtimeMs <= ctx.activeWindowMs) found.push({ dir, id: d.name, mtimeMs });
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = found.slice(0, ctx.maxSessionsPerAgent);
    const keepSet = new Set(keep.map((k) => k.dir));
    for (const k of keep) if (!this.tracked.has(k.dir)) this.tracked.set(k.dir, this.blank(k.id, k.dir));
    for (const dir of [...this.tracked.keys()]) if (!keepSet.has(dir)) this.tracked.delete(dir);
  }

  private onStep(st: AgState, rec: unknown, ctx: AdapterContext): void {
    if (!rec || typeof rec !== 'object') return;
    const o = rec as Record<string, any>;
    const at = parseTime(o.created_at) ?? st.updatedAt;
    st.steps += 1;
    const type = String(o.type ?? '');
    if (at) {
      if (st.startedAt === undefined || at < st.startedAt) st.startedAt = at;
      if (at > st.updatedAt) st.updatedAt = at;
      // The agent's own steps close a stretch of its work; the person's input does not.
      if (type !== 'USER_INPUT') addWork(st.daily, st.lastStepAt, at);
      if (st.lastStepAt === undefined || at > st.lastStepAt) st.lastStepAt = at;
    }
    const status = String(o.status ?? '');
    const source = String(o.source ?? '');
    const tools: string[] = [];
    const gemini = path.join(ctx.home, '.gemini');
    const running = st.recent[0];
    if (running && running.endedAt === undefined && status !== 'RUNNING') running.endedAt = at;

    for (const tc of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
      const name = String(tc?.name ?? '');
      if (!name) continue;
      tools.push(name);
      const args = (tc.args && typeof tc.args === 'object' ? tc.args : {}) as Record<string, unknown>;
      const action = decodeArg(args.toolAction);
      const cmd = decodeArg(args.CommandLine);
      st.activity = {
        kind: name === 'run_command' ? 'command' : name === 'invoke_subagent' ? 'subagent' : 'tool',
        label: typeof action === 'string' && action ? truncate(action, 70) : humanize(name),
        detail: typeof cmd === 'string' ? truncate(cmd, 80) : undefined,
        startedAt: at,
      };
      if (!ASK_TOOLS.has(name)) {
        st.recent.unshift(st.activity);
        if (st.recent.length > 6) st.recent.length = 6;
        st.timer.step();
      }
      for (const [key, weight] of Object.entries(PATH_ARGS)) {
        const v = decodeArg(args[key]);
        if (typeof v !== 'string' || !path.isAbsolute(v) || isWithin(v, gemini)) continue;
        const dir = key === 'Cwd' || key === 'DirectoryPath' || key === 'SearchDirectory' ? v : path.dirname(v);
        st.votes.set(dir, (st.votes.get(dir) ?? 0) + weight);
      }
    }

    if (type === 'USER_INPUT' && typeof o.content === 'string') this.onUserInput(st, o.content, source, gemini);
    if (type === 'USER_INPUT' && source === 'USER_EXPLICIT') {
      st.turnSteps = 0;
      st.turnStartedAt = at;
    }
    st.turnSteps += tools.length;
    if (type === 'ERROR_MESSAGE') st.error = firstLine(errorMessage(o.content) ?? errorMessage(o.error) ?? 'Error', 120);
    else if (source === 'MODEL') st.error = undefined;

    st.pendingAsk = undefined;
    if (type === 'PLANNER_RESPONSE') {
      const ask = tools.find((t) => ASK_TOOLS.has(t));
      if (ask) st.pendingAsk = ask === 'ask_permission' ? 'Needs your permission' : 'Waiting for your answer';
      if (tools.length === 0) st.activity = undefined;
    } else if (type === 'ASK_QUESTION' && status !== 'DONE') {
      st.pendingAsk = 'Waiting for your answer';
    }
    st.lastStep = { type, status, source, at, tools };
  }

  /**
   * A user turn looks like:
   *   <USER_REQUEST>the prompt</USER_REQUEST>
   *   <ADDITIONAL_METADATA>… Active Document: /abs/path/file.ts (LANGUAGE_TS) …</ADDITIONAL_METADATA>
   *   <USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from X to Gemini 3.1 Pro (High). …</USER_SETTINGS_CHANGE>
   */
  private onUserInput(st: AgState, content: string, source: string, gemini: string): void {
    const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1] ?? content.replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, '');
    if (source === 'USER_EXPLICIT' && !st.firstInput && request.trim()) st.firstInput = firstLine(request, 100);
    const model = /`Model Selection` from .*? to (.+?)\.(?:\s|$)/.exec(content)?.[1];
    if (model) st.model = model.trim();
    const doc = /Active Document: (\/[^\n]+?)(?: \([A-Z_]+\))?\s*$/m.exec(content)?.[1];
    if (doc && path.isAbsolute(doc) && !isWithin(doc, gemini)) {
      const dir = path.dirname(doc);
      st.votes.set(dir, (st.votes.get(dir) ?? 0) + 1);
    }
  }

  private async readTask(st: AgState): Promise<void> {
    const file = path.join(st.dir, 'task.md');
    const s = await statSafe(file);
    if (!s) {
      st.task = undefined;
      return;
    }
    if (st.task?.mtimeMs === s.mtimeMs) return;
    const md = await readTextSafe(file, 1 << 20);
    const parsed = md ? parseChecklist(md) : undefined;
    const meta = await readJsonSafe<Record<string, unknown>>(path.join(st.dir, 'task.md.metadata.json'));
    st.task = {
      mtimeMs: s.mtimeMs,
      title: (parsed?.title !== undefined ? withoutTrackerSuffix(parsed.title) : undefined) || undefined,
      tasks: parsed?.tasks ?? [],
      summary: typeof meta?.summary === 'string' ? meta.summary : undefined,
    };
    st.timer.observe(st.task.tasks, s.mtimeMs);
    if (s.mtimeMs > st.updatedAt) st.updatedAt = s.mtimeMs;
    st.startedAt ??= s.mtimeMs;
  }

  /**
   * The project is inferred from the paths the agent touched: the git repository most of
   * them live in, or else the common ancestor of the frequently used folders.
   */
  private projectOf(st: AgState, home: string): string | undefined {
    if (st.projectVotesAt === st.steps) return st.project;
    st.projectVotesAt = st.steps;
    st.project = inferProject(st.votes, home);
    return st.project;
  }

  private toSession(st: AgState, ctx: AdapterContext): AgentSession | undefined {
    if (!st.startedAt) return undefined;
    const now = ctx.now();
    const tasks = st.task?.tasks ?? [];
    const prog = progressOf(tasks);
    const allDone = prog.total > 0 && prog.done === prog.total;
    const last = st.lastStep;
    const age = now - st.updatedAt;

    let status: AgentSession['status'] = allDone ? 'done' : 'idle';
    let detail: string | undefined;
    if (last) {
      if (st.pendingAsk) {
        status = 'waiting';
        detail = st.pendingAsk;
      } else if (last.status === 'RUNNING') {
        status = age < ctx.staleAfterMs ? 'working' : 'stale';
      } else if (last.type === 'ERROR_MESSAGE' || last.status === 'ERROR') {
        status = 'error';
        detail = st.error;
      } else if (last.type === 'PLANNER_RESPONSE' && last.tools.length === 0) {
        status = allDone ? 'done' : 'idle';
      } else if (age < PAUSED_AFTER_MS) {
        status = 'working';
      } else {
        if (!allDone) detail = 'Paused';
      }
    }
    if (status === 'stale') detail = `No activity for ${Math.round(age / 60_000)}m`;

    const current = tasks.find((t) => t.status === 'in_progress');
    let activity = status === 'working' ? st.activity : undefined;
    if (status === 'working' && !activity) activity = { kind: 'thinking', label: 'Planning', startedAt: st.updatedAt };

    return {
      key: `antigravity:${st.id}`,
      agent: 'antigravity',
      agentLabel: this.label,
      id: st.id,
      title: st.task?.title || st.firstInput || current?.title || 'Antigravity conversation',
      titleFromPrompt: !st.task?.title && !!st.firstInput ? true : undefined,
      projectPath: this.projectOf(st, ctx.home),
      model: st.model,
      turn: st.turnStartedAt !== undefined ? { steps: st.turnSteps, startedAt: st.turnStartedAt } : undefined,
      current: status === 'working' || status === 'waiting' ? st.timer.current(tasks) : undefined,
      recent: st.recent.slice(0, 5),
      status,
      statusDetail: detail,
      startedAt: st.startedAt,
      updatedAt: st.updatedAt,
      tasks,
      activity,
      daily: Object.keys(st.daily).length ? st.daily : undefined,
      sources: [path.join(st.dir, 'task.md'), st.tail.path],
    };
  }
}

/** "Fix the cart — Task Tracker" → "Fix the cart", read without a regex that long titles could slow down. */
function withoutTrackerSuffix(title: string): string {
  const s = title.trim();
  if (!s.toLowerCase().endsWith('task tracker')) return s;
  const rest = s.slice(0, -'task tracker'.length).trimEnd();
  return /[—–-]$/.test(rest) ? rest.slice(0, -1).trim() : s;
}
