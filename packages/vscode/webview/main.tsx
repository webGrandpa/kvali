import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  STATUS_LABEL,
  currentTask,
  fmtAgo,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  groupByProject,
  pathWithin,
  progressOf,
  sessionTokens,
  todayUsage,
  type AgentSession,
  type Progress,
  type ProjectGroup,
  type SessionStatus,
  type TaskItem,
} from '@kvali/core/browser';
import type { FromWebview, Scope, ViewState } from '../src/messages.ts';
import { Chevron, StatusIcon, TaskIcon } from './icons.tsx';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

interface UiState {
  expanded: string[];
  collapsed: string[];
}

function shortModel(model: string): string {
  const m = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=-|$|\[)/i.exec(model);
  if (m) return `${m[1].toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return model.length > 22 ? `${model.slice(0, 21)}…` : model;
}

function tokenTitle(s: AgentSession): string {
  const t = s.tokens;
  if (!t) return '';
  const parts = [`Input ${fmtTokens(t.input)}`, `Output ${fmtTokens(t.output)}${t.reasoning ? ` (reasoning ${fmtTokens(t.reasoning)})` : ''}`];
  if (t.cacheRead) parts.push(`Cache read ${fmtTokens(t.cacheRead)}`);
  if (t.cacheWrite) parts.push(`Cache write ${fmtTokens(t.cacheWrite)}`);
  return parts.join(' · ');
}

function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span class={`pill s-${status}`}>
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function Meter({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  const level = v >= 90 ? 'high' : v >= 70 ? 'mid' : 'low';
  return (
    <span class={`meter ${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <span style={{ width: `${v}%` }} />
    </span>
  );
}

function ProgressBar({ p, moving }: { p: Progress; moving: boolean }) {
  const rest = p.total - p.done - p.inProgress;
  return (
    <div class="progress">
      <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label={`${p.done} of ${p.total} tasks done`}>
        {p.done > 0 && <span class="seg done" style={{ flexGrow: p.done }} />}
        {p.inProgress > 0 && <span class={`seg active ${moving ? 'moving' : ''}`} style={{ flexGrow: p.inProgress }} />}
        {rest > 0 && <span class="seg rest" style={{ flexGrow: rest }} />}
      </div>
      <span class="count">
        <strong>
          {p.done}/{p.total}
        </strong>
        <span class="muted"> · {p.percent}%</span>
      </span>
    </div>
  );
}

function TaskList({ tasks }: { tasks: TaskItem[] }) {
  let group: string | undefined;
  const rows = [];
  for (const t of tasks) {
    if (t.group && t.group !== group) {
      group = t.group;
      rows.push(
        <li key={`g-${t.id}`} class="task-group">
          {t.group}
        </li>,
      );
    }
    rows.push(
      <li key={t.id} class={`task t-${t.status}`} style={{ paddingLeft: `${(t.depth ?? 0) * 14}px` }}>
        <TaskIcon status={t.status} />
        <span>{t.status === 'in_progress' ? (t.activeTitle ?? t.title) : t.title}</span>
      </li>,
    );
  }
  return <ul class="tasks">{rows}</ul>;
}

function Card({ s, now, expanded, onToggle, showCost }: { s: AgentSession; now: number; expanded: boolean; onToggle: () => void; showCost: boolean }) {
  const p = progressOf(s.tasks);
  const step = currentTask(s.tasks);
  const tok = sessionTokens(s);
  const ctxPct = s.context?.window ? Math.min(100, Math.round((s.context.used / s.context.window) * 100)) : undefined;
  const working = s.status === 'working';
  const showDetail = !!s.statusDetail && !working;
  const canResume = (s.agent === 'claude-code' || s.agent === 'codex') && !working && s.status !== 'waiting';

  return (
    <article class={`card s-${s.status} agent-${s.agent}`}>
      <div class="row top">
        <span class="agent">
          <i class="dot" />
          {s.agentLabel}
        </span>
        <StatusPill status={s.status} />
        <span class="spacer" />
        <time class="muted" title={new Date(s.updatedAt).toLocaleString()}>
          {fmtAgo(s.updatedAt, now)}
        </time>
      </div>

      <h3 class="title" title={s.title}>
        {s.title}
      </h3>

      {showDetail && <div class={`detail d-${s.status}`}>{s.statusDetail}</div>}

      {p.total > 0 && <ProgressBar p={p} moving={working} />}

      {working && (step || s.activity) && (
        <div class="now">
          {step && <div class="step">{step.activeTitle ?? step.title}</div>}
          {s.activity && (
            <>
              <div class="activity">
                <span class="act-label">{s.activity.label}</span>
                <span class="elapsed">{fmtDuration(now - s.activity.startedAt)}</span>
              </div>
              {s.activity.detail && (
                <code class="act-detail" title={s.activity.detail}>
                  {s.activity.detail}
                </code>
              )}
            </>
          )}
        </div>
      )}

      <div class="meta">
        {tok !== undefined ? (
          <span title={tokenTitle(s)}>
            <strong>{fmtTokens(tok)}</strong> tokens
          </span>
        ) : (
          <span class="muted" title="This agent does not record token usage on disk">
            tokens n/a
          </span>
        )}
        {showCost && s.costUsd !== undefined && <span title="Estimated at API list prices">≈{fmtUsd(s.costUsd)}</span>}
        {ctxPct !== undefined && (
          <span class="ctx" title={`Context window: ${fmtTokens(s.context!.used)} of ${fmtTokens(s.context!.window)}`}>
            ctx <Meter value={ctxPct} label="Context window used" /> {ctxPct}%
          </span>
        )}
        {s.activeSubagents ? <span>{s.activeSubagents} subagent{s.activeSubagents > 1 ? 's' : ''}</span> : null}
        {s.model && <span class="muted model">{shortModel(s.model)}</span>}
      </div>

      <div class="actions">
        {s.tasks.length > 0 && (
          <button class="link" aria-expanded={expanded} onClick={onToggle}>
            <Chevron open={expanded} />
            {s.tasks.length} task{s.tasks.length === 1 ? '' : 's'}
          </button>
        )}
        <span class="spacer" />
        {canResume && (
          <button class="link" title="Continue this session in a new terminal" onClick={() => post({ type: 'resume', key: s.key })}>
            Resume
          </button>
        )}
        <button class="link" title={s.sources[0]} onClick={() => post({ type: 'open', key: s.key })}>
          Open
        </button>
      </div>

      {expanded && <TaskList tasks={s.tasks} />}
    </article>
  );
}

function Group({ g, now, ui, setUi, showCost }: { g: ProjectGroup; now: number; ui: UiState; setUi: (u: UiState) => void; showCost: boolean }) {
  const id = g.path ?? '';
  const open = !ui.collapsed.includes(id);
  const active = g.sessions.filter((s) => s.status === 'working' || s.status === 'waiting').length;
  const toggle = () => setUi({ ...ui, collapsed: open ? [...ui.collapsed, id] : ui.collapsed.filter((c) => c !== id) });
  return (
    <section class="group">
      <button class="group-head" aria-expanded={open} title={g.path} onClick={toggle}>
        <Chevron open={open} />
        <span class="group-text">
          <span class="group-line">
            <span class="name">{g.name}</span>
            {g.inWorkspace && <span class="badge">this workspace</span>}
            {active > 0 && <span class="badge live">{active} active</span>}
          </span>
          <span class="muted small group-sub">
            {g.sessions.length} session{g.sessions.length === 1 ? '' : 's'}
            {g.today.tokens > 0 && ` · ${fmtTokens(g.today.tokens)} tokens today`}
            {showCost && g.today.costUsd > 0 ? ` · ≈${fmtUsd(g.today.costUsd)}` : ''}
          </span>
        </span>
      </button>
      {open &&
        g.sessions.map((s) => (
          <Card
            key={s.key}
            s={s}
            now={now}
            showCost={showCost}
            expanded={ui.expanded.includes(s.key)}
            onToggle={() =>
              setUi({ ...ui, expanded: ui.expanded.includes(s.key) ? ui.expanded.filter((k) => k !== s.key) : [...ui.expanded, s.key] })
            }
          />
        ))}
    </section>
  );
}

function Limits({ sessions, now }: { sessions: AgentSession[]; now: number }) {
  const latest = new Map<string, AgentSession>();
  for (const s of sessions) {
    if (!s.rateLimits?.length) continue;
    const cur = latest.get(s.agent);
    if (!cur || s.updatedAt > cur.updatedAt) latest.set(s.agent, s);
  }
  if (!latest.size) return null;
  return (
    <section class="limits" aria-label="Plan limits">
      {[...latest.values()].flatMap((s) =>
        s.rateLimits!.map((r) => (
          <div class={`limit agent-${s.agent}`} key={`${s.agent}-${r.label}`}>
            <span class="limit-name">
              <i class="dot" />
              {s.agentLabel} · {r.label}
            </span>
            <Meter value={r.usedPercent} label={`${s.agentLabel} ${r.label} limit used`} />
            <span class="pct">{Math.round(r.usedPercent)}%</span>
            {r.resetsAt && r.resetsAt > now && <span class="muted small">resets in {fmtDuration(r.resetsAt - now)}</span>}
          </div>
        )),
      )}
    </section>
  );
}

function Counts({ sessions }: { sessions: AgentSession[] }) {
  const c: Partial<Record<SessionStatus, number>> = {};
  for (const s of sessions) c[s.status] = (c[s.status] ?? 0) + 1;
  const order: SessionStatus[] = ['waiting', 'working', 'error', 'done', 'idle'];
  const items = order.filter((k) => c[k]);
  if (!items.length) return null;
  return (
    <div class="counts">
      {items.map((k) => (
        <span key={k} class={`count-item s-${k}`}>
          <StatusIcon status={k} />
          {c[k]} {STATUS_LABEL[k].toLowerCase()}
        </span>
      ))}
    </div>
  );
}

function Empty({ hours, scope }: { hours: number; scope: Scope }) {
  return (
    <div class="empty">
      <p class="lead">
        No agent activity in the last {hours}h{scope === 'workspace' ? ' in this workspace' : ''}.
      </p>
      <p>
        Start <b>Claude Code</b>, <b>Codex</b>, <b>Gemini CLI</b> or an <b>Antigravity</b> agent. Sessions, their plan and token usage appear here
        automatically.
      </p>
      <p>Using Cursor, Copilot, Windsurf or another agent? Ask it to report progress through AGENTS.md:</p>
      <button class="btn" onClick={() => post({ type: 'command', command: 'kvali.addProgressProtocol' })}>
        Add progress protocol
      </button>
      {scope === 'workspace' && (
        <p>
          <button class="link" onClick={() => post({ type: 'setScope', scope: 'all' })}>
            Show all projects
          </button>
        </p>
      )}
    </div>
  );
}

function App() {
  const [st, setSt] = useState<ViewState>();
  const [now, setNow] = useState(Date.now());
  const [ui, setUiState] = useState<UiState>(() => ({ expanded: [], collapsed: [], ...((vscode.getState() as UiState | undefined) ?? {}) }));
  const setUi = (u: UiState) => {
    setUiState(u);
    vscode.setState(u);
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'state') setSt(e.data as ViewState);
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(t);
    };
  }, []);

  if (!st) return <div class="loading muted">Looking for agent sessions…</div>;

  const inWs = (s: AgentSession) => st.workspaceRoots.some((r) => pathWithin(s.projectPath, r));
  const sessions = st.scope === 'workspace' ? st.snapshot.sessions.filter(inWs) : st.snapshot.sessions;
  const groups = groupByProject(sessions, st.workspaceRoots, now);
  const today = todayUsage(sessions, now);
  const hasClaude = st.snapshot.sessions.some((s) => s.agent === 'claude-code');

  return (
    <main>
      <header class="summary">
        <div class="today">
          <span class="muted">Today</span> <strong>{fmtTokens(today.tokens)}</strong> tokens
          {st.showCost && today.priced && (
            <>
              {' '}
              · <strong title="Estimated at API list prices">≈{fmtUsd(today.costUsd)}</strong>
            </>
          )}
        </div>
        <div class="seg-toggle" role="group" aria-label="Scope">
          <button aria-pressed={st.scope === 'all'} onClick={() => post({ type: 'setScope', scope: 'all' })}>
            All
          </button>
          <button aria-pressed={st.scope === 'workspace'} onClick={() => post({ type: 'setScope', scope: 'workspace' })}>
            Workspace
          </button>
        </div>
      </header>
      <Counts sessions={sessions} />
      <Limits sessions={sessions} now={now} />

      {groups.length === 0 ? <Empty hours={st.activeWindowHours} scope={st.scope} /> : groups.map((g) => <Group key={g.path ?? ''} g={g} now={now} ui={ui} setUi={setUi} showCost={st.showCost} />)}

      {hasClaude && st.claudeHooks !== 'installed' && (
        <aside class="tip">
          <p>
            <b>Know the moment Claude needs you.</b> Claude Code's transcript does not record permission prompts. Kvali's hooks add an exact
            “Needs you” status and alerts.
          </p>
          <button class="btn" onClick={() => post({ type: 'command', command: 'kvali.installClaudeHooks' })}>
            {st.claudeHooks === 'outdated' ? 'Update hooks' : 'Install Claude Code hooks'}
          </button>
        </aside>
      )}

      {st.snapshot.errors.map((e) => (
        <p class="error-line" key={e.agent}>
          {e.agent}: {e.message}{' '}
          <button class="link" onClick={() => post({ type: 'command', command: 'kvali.showLog' })}>
            Log
          </button>
        </p>
      ))}
    </main>
  );
}

render(<App />, document.getElementById('root')!);
