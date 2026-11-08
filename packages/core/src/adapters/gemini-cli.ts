/**
 * Gemini CLI adapter.
 *
 * Reads <runtime>/tmp/<project>/chats/session-*.jsonl, where <runtime> is ~/.gemini
 * (or ~/.cache/.gemini under the macOS sandbox). `<runtime>/tmp/<project>/.project_root`
 * holds the project's absolute path. Older versions wrote one `.json` file per session.
 *
 * The JSONL format is append-only: message records (`{id, type, ...}`), `$patch`
 * records that update earlier messages, `$set` metadata updates and `$rewindTo`.
 *
 * - Progress: the latest `write_todos` tool call (`{ todos: [{ description, status }] }`).
 * - Tokens: `tokens` on each `gemini` message (`input` includes `cached`).
 */
import path from 'node:path';
import type { Adapter, AdapterContext } from '../adapter.ts';
import { staleness } from '../adapter.ts';
import type { Activity, AgentSession, DailyUsage, TaskItem, TaskStatus, TokenUsage } from '../model.ts';
import { emptyTokens, progressOf } from '../model.ts';
import { listDir, readTextSafe, statSafe } from '../util/fs.ts';
import { JsonlTail } from '../util/jsonl.ts';
import { contentText, firstLine, truncate } from '../util/text.ts';
import { addTaskDone, addWork, dayKey, parseTime } from '../util/time.ts';

type Msg = Record<string, any>;

interface GeminiState {
  file: string;
  projectPath?: string;
  sessionId?: string;
  summary?: string;
  startTime?: number;
  lastUpdated?: number;
  kind?: string;
  messages: Map<string, Msg>;
  dirty: boolean;
  cached?: AgentSession;
}

const PENDING_TOOL = new Set(['scheduled', 'validating', 'executing']);

function todoStatus(s: unknown): TaskStatus {
  switch (s) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

export function applyGeminiRecord(st: GeminiState, rec: unknown): void {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
  const r = rec as Record<string, any>;
  st.dirty = true;

  if (typeof r.$rewindTo === 'string') {
    let found = false;
    for (const id of [...st.messages.keys()]) {
      if (id === r.$rewindTo) found = true;
      if (found) st.messages.delete(id);
    }
    if (!found) st.messages.clear();
    return;
  }
  if (r.$patch && typeof r.$patch === 'object') {
    const patch = r.$patch;
    const applyOne = (u: Msg) => {
      const m = typeof u?.id === 'string' ? st.messages.get(u.id) : undefined;
      if (!m) return;
      if ('content' in u) m.content = u.content;
      if (Array.isArray(u.toolCalls) && Array.isArray(m.toolCalls)) {
        for (const tp of u.toolCalls) {
          const tc = m.toolCalls.find((t: Msg) => t.id === tp.id);
          if (tc) Object.assign(tc, tp);
        }
      }
    };
    if (typeof patch.id === 'string') applyOne(patch);
    if (Array.isArray(patch.updates)) patch.updates.forEach(applyOne);
    if (Array.isArray(patch.removeIds)) for (const id of patch.removeIds) st.messages.delete(id);
    return;
  }
  if (typeof r.id === 'string' && typeof r.type === 'string') {
    st.messages.set(r.id, r);
    return;
  }
  const meta = r.$set && typeof r.$set === 'object' ? r.$set : typeof r.sessionId === 'string' ? r : undefined;
  if (!meta) return;
  if (typeof meta.sessionId === 'string') st.sessionId = meta.sessionId;
  if (typeof meta.summary === 'string') st.summary = meta.summary;
  if (typeof meta.kind === 'string') st.kind = meta.kind;
  const start = parseTime(meta.startTime);
  if (start) st.startTime = start;
  const upd = parseTime(meta.lastUpdated);
  if (upd) st.lastUpdated = upd;
  if (Array.isArray(meta.messages)) {
    st.messages.clear();
    for (const m of meta.messages) if (typeof m?.id === 'string') st.messages.set(m.id, m);
  }
}

export class GeminiCliAdapter implements Adapter {
  readonly id = 'gemini-cli';
  readonly label = 'Gemini CLI';

  private readonly tracked = new Map<string, { tail?: JsonlTail; mtimeMs: number; state: GeminiState }>();
  private lastDiscovery = 0;

  private roots(ctx: AdapterContext): string[] {
    const homes = [ctx.env.GEMINI_CLI_HOME, ctx.home].filter((h): h is string => !!h);
    const out = new Set<string>();
    for (const h of homes) {
      out.add(path.join(h, '.gemini', 'tmp'));
      out.add(path.join(h, '.cache', '.gemini', 'tmp'));
    }
    return [...out];
  }

  async poll(ctx: AdapterContext): Promise<AgentSession[]> {
    const now = ctx.now();
    if (this.tracked.size === 0 || now - this.lastDiscovery >= 5_000) {
      this.lastDiscovery = now;
      await this.discover(ctx);
    }
    const out: AgentSession[] = [];
    for (const [file, t] of this.tracked) {
      if (t.tail) {
        await t.tail.read(
          (rec) => applyGeminiRecord(t.state, rec),
          () => {
            t.state = this.createState(file, t.state.projectPath);
          },
        );
      } else {
        const st = await statSafe(file);
        if (st && st.mtimeMs !== t.mtimeMs) {
          t.mtimeMs = st.mtimeMs;
          const text = await readTextSafe(file, 64 << 20);
          if (text) {
            try {
              const fresh = this.createState(file, t.state.projectPath);
              applyGeminiRecord(fresh, { $set: JSON.parse(text) });
              t.state = fresh;
            } catch {
              /* partially written file: retry next poll */
            }
          }
        }
      }
      const s = this.toSession(t.state, ctx);
      if (s) out.push(s);
    }
    return out;
  }

  private createState(file: string, projectPath?: string): GeminiState {
    return { file, projectPath, messages: new Map(), dirty: true };
  }

  private async discover(ctx: AdapterContext): Promise<void> {
    const now = ctx.now();
    const found: { file: string; mtimeMs: number; project?: string }[] = [];
    for (const root of this.roots(ctx)) {
      for (const proj of await listDir(root)) {
        if (!proj.isDirectory()) continue;
        const projDir = path.join(root, proj.name);
        const chats = path.join(projDir, 'chats');
        const files = (await listDir(chats)).filter(
          (f) => f.isFile() && f.name.startsWith('session-') && (f.name.endsWith('.jsonl') || f.name.endsWith('.json')),
        );
        if (files.length === 0) continue;
        let project: string | undefined;
        for (const f of files) {
          const file = path.join(chats, f.name);
          const st = await statSafe(file);
          if (!st || now - st.mtimeMs > ctx.activeWindowMs) continue;
          if (project === undefined) project = (await readTextSafe(path.join(projDir, '.project_root'), 8192))?.trim() || '';
          found.push({ file, mtimeMs: st.mtimeMs, project: project || undefined });
        }
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const keep = found.slice(0, ctx.maxSessionsPerAgent);
    const keepSet = new Set(keep.map((k) => k.file));
    for (const k of keep) {
      if (this.tracked.has(k.file)) continue;
      // A legacy `.json` session that also has a `.jsonl` twin was migrated; prefer the `.jsonl`.
      if (k.file.endsWith('.json') && keepSet.has(k.file + 'l')) continue;
      this.tracked.set(k.file, {
        tail: k.file.endsWith('.jsonl') ? new JsonlTail(k.file) : undefined,
        mtimeMs: -1,
        state: this.createState(k.file, k.project),
      });
    }
    for (const file of [...this.tracked.keys()]) if (!keepSet.has(file)) this.tracked.delete(file);
  }

  private toSession(st: GeminiState, ctx: AdapterContext): AgentSession | undefined {
    if (!st.dirty && st.cached) return this.refreshStatus(st.cached, ctx);
    st.dirty = false;
    if (st.kind === 'subagent') return undefined;

    const msgs = [...st.messages.values()];
    if (msgs.length === 0) return undefined;

    const tokens: TokenUsage = emptyTokens();
    const daily: Record<string, DailyUsage> = {};
    let tasks: TaskItem[] = [];
    let title: string | undefined;
    let model: string | undefined;
    let context: number | undefined;
    let startedAt = st.startTime;
    let updatedAt = 0;
    let lastActivity: Activity | undefined;
    let costUsd: number | undefined = 0;
    let prevTs: number | undefined;
    const todoStatusSeen = new Map<string, TaskItem['status']>();

    for (const m of msgs) {
      const ts = parseTime(m.timestamp) ?? 0;
      if (ts) {
        if (startedAt === undefined || ts < startedAt) startedAt = ts;
        if (ts > updatedAt) updatedAt = ts;
        // Gemini's own messages close a stretch of its work; the person's do not.
        if (m.type === 'gemini') addWork(daily, prevTs, ts);
        prevTs = Math.max(prevTs ?? 0, ts);
      }
      if (m.type === 'user' && !title) {
        const text = contentText(m.content);
        if (text.trim() && !text.trim().startsWith('/')) title = firstLine(text, 100);
      }
      if (m.type !== 'gemini') continue;
      if (typeof m.model === 'string') model = m.model;
      const t = m.tokens;
      if (t && typeof t === 'object') {
        const cached = Number(t.cached) || 0;
        const thoughts = Number(t.thoughts) || 0;
        const usage: TokenUsage = {
          input: Math.max(0, (Number(t.input) || 0) - cached) + (Number(t.tool) || 0),
          output: (Number(t.output) || 0) + thoughts,
          cacheRead: cached,
          cacheWrite: 0,
          reasoning: thoughts,
        };
        tokens.input += usage.input;
        tokens.output += usage.output;
        tokens.cacheRead += usage.cacheRead;
        tokens.reasoning = (tokens.reasoning ?? 0) + thoughts;
        context = (Number(t.input) || 0) + (Number(t.tool) || 0);
        const cost = ctx.pricing.cost(m.model ?? model, { ...usage, cacheWrite5m: 0, cacheWrite1h: 0 });
        if (cost === undefined) costUsd = undefined;
        else if (costUsd !== undefined) costUsd += cost;
        const b = (daily[dayKey(ts || ctx.now())] ??= { tokens: 0, costUsd: 0 });
        b.tokens += usage.input + usage.output + usage.cacheRead;
        b.costUsd += cost ?? 0;
      }
      for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        if (tc?.name === 'write_todos' && Array.isArray(tc.args?.todos)) {
          tasks = tc.args.todos.map((todo: any, i: number) => ({
            id: String(i + 1),
            title: String(todo?.description ?? ''),
            status: todoStatus(todo?.status),
          }));
          for (const t of tasks) {
            const before = todoStatusSeen.get(t.title);
            if (t.status === 'completed' && before !== undefined && before !== 'completed' && ts) addTaskDone(daily, ts);
            todoStatusSeen.set(t.title, t.status);
          }
        }
      }
    }

    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].type === 'user') {
        lastUser = i;
        break;
      }
    }
    let turnSteps = 0;
    for (const m of msgs.slice(lastUser + 1)) if (m.type === 'gemini' && Array.isArray(m.toolCalls)) turnSteps += m.toolCalls.length;
    const turn = lastUser >= 0 ? { steps: turnSteps, startedAt: parseTime(msgs[lastUser].timestamp) ?? updatedAt } : undefined;

    const last = msgs[msgs.length - 1];
    let phase: 'working' | 'waiting' | 'idle' | 'error' = 'idle';
    let detail: string | undefined;
    if (last.type === 'user') phase = 'working';
    else if (last.type === 'error') {
      phase = 'error';
      detail = firstLine(contentText(last.content) || 'Error', 120);
    } else if (last.type === 'gemini') {
      const calls: Msg[] = Array.isArray(last.toolCalls) ? last.toolCalls : [];
      const awaiting = calls.find((c) => c.status === 'awaiting_approval');
      const pending = calls.find((c) => PENDING_TOOL.has(c.status));
      const lastCall = calls[calls.length - 1];
      if (awaiting) {
        phase = 'waiting';
        detail = `Needs approval: ${awaiting.displayName ?? awaiting.name}`;
      } else if (pending || (lastCall && lastCall.result === undefined)) phase = 'working';
      else if (calls.length > 0) phase = 'working'; // tool results go back to the model next
      if (lastCall) {
        lastActivity = {
          kind: lastCall.name === 'run_shell_command' ? 'command' : 'tool',
          label: String(lastCall.displayName ?? lastCall.name),
          detail: typeof lastCall.description === 'string' ? truncate(lastCall.description, 80) : undefined,
          startedAt: parseTime(lastCall.timestamp) ?? updatedAt,
        };
      }
    }

    const tasksProg = progressOf(tasks);
    const session: AgentSession = {
      key: `gemini-cli:${st.sessionId ?? st.file}`,
      agent: 'gemini-cli',
      agentLabel: this.label,
      id: st.sessionId ?? path.basename(st.file),
      title: st.summary ? truncate(st.summary, 100) : (title ?? 'Untitled session'),
      titleFromPrompt: !st.summary && title !== undefined ? true : undefined,
      projectPath: st.projectPath,
      model,
      status: phase === 'idle' && tasksProg.total > 0 && tasksProg.done === tasksProg.total ? 'done' : phase,
      statusDetail: detail,
      startedAt: startedAt ?? updatedAt,
      updatedAt: Math.max(updatedAt, st.lastUpdated ?? 0),
      tasks,
      activity: lastActivity,
      turn,
      tokens,
      costUsd,
      daily,
      context: context !== undefined ? { used: context, window: 1_048_576 } : undefined,
      host: 'terminal',
      sources: [st.file],
    };
    st.cached = session;
    return this.refreshStatus(session, ctx);
  }

  /** Re-evaluates time-based status (staleness) without re-folding messages. */
  private refreshStatus(s: AgentSession, ctx: AdapterContext): AgentSession {
    if (s.status !== 'working') return s.status === 'waiting' ? s : { ...s, activity: undefined };
    const stale = staleness(s.updatedAt, ctx);
    return stale ? { ...s, status: 'stale', statusDetail: stale, activity: undefined } : s;
  }
}
