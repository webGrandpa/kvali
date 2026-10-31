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
  qrMatrix,
  sessionTodayTokens,
  sessionTokens,
  todayUsage,
  type AgentSession,
  type Progress,
  type ProjectGroup,
  type SessionStatus,
  type TaskItem,
} from '@kvali/core/browser';
import type { FromWebview, PhoneView, Scope, ViewState } from '../src/messages.ts';
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

/** Shown while an agent works without a plan: an indeterminate bar plus how many steps this turn took. */
function NoPlanBar({ s, now, autoPlans }: { s: AgentSession; now: number; autoPlans: boolean }) {
  const steps = s.turn?.steps ?? 0;
  return (
    <>
      <div class="progress">
        <div class="bar indeterminate" role="progressbar" aria-label="Working without a plan">
          <span />
        </div>
        <span class="count">
          <strong>
            {steps} step{steps === 1 ? '' : 's'}
          </strong>
          {s.turn && <span class="muted"> · {fmtDuration(now - s.turn.startedAt)}</span>}
        </span>
      </div>
      <div class="noplan">
        {autoPlans ? (
          <span class="muted">% appears as soon as the agent writes its plan.</span>
        ) : (
          <>
            <span class="muted">No plan yet.</span>
            <button class="link" title="One-time setup: agents keep a plan automatically" onClick={() => post({ type: 'runSetup' })}>
              Turn on automatic plans
            </button>
          </>
        )}
      </div>
    </>
  );
}

const QUIET_WARN_MS = 5 * 60_000;

/** The current step: its own progress bar (elapsed vs. this plan's typical step), liveness, and the latest actions. */
function NowPanel({ s, step, now }: { s: AgentSession; step: TaskItem | undefined; now: number }) {
  const cur = s.current;
  const elapsed = cur ? now - cur.startedAt : 0;
  const ratio = cur?.typicalMs ? elapsed / cur.typicalMs : undefined;
  const slow = ratio !== undefined && ratio > 1.5;
  return (
    <div class="now">
      {step && <div class="step">{step.activeTitle ?? step.title}</div>}
      {cur &&
        (ratio !== undefined ? (
          <div class="stepbar">
            <div class={`bar mini ${slow ? 'slow' : ''}`} role="progressbar" aria-label="Time on this step compared with earlier steps">
              <span style={{ width: `${Math.min(95, Math.round(ratio * 100))}%` }} />
            </div>
            <span class={`small ${slow ? 'warn' : 'muted'}`}>
              {fmtDuration(elapsed)} of ~{fmtDuration(cur.typicalMs!)}
              {slow ? ' · slower than earlier steps' : ''}
            </span>
          </div>
        ) : (
          <div class="muted small">
            On this step {fmtDuration(elapsed)}
            {cur.steps ? ` · ${cur.steps} action${cur.steps === 1 ? '' : 's'}` : ''}
          </div>
        ))}
      <Liveness s={s} now={now} />
      {s.recent && s.recent.length > 0 && (
        <ul class="recent">
          {s.recent.slice(0, 3).map((a, i) => (
            <li key={`${a.startedAt}-${i}`} class={a.endedAt ? 'done' : 'running'}>
              <span class="mark">{a.endedAt ? '✓' : '›'}</span>
              <span class="what">
                {a.label}
                {a.detail && <code> {a.detail}</code>}
              </span>
              <span class="muted when">{a.endedAt ? fmtDuration(a.endedAt - a.startedAt) : fmtDuration(now - a.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Is it working, waiting on a long command, retrying, or silent? */
function Liveness({ s, now }: { s: AgentSession; now: number }) {
  const quiet = now - s.updatedAt;
  const a = s.activity;
  const running = a && !a.endedAt && a.kind !== 'thinking' && a.kind !== 'message';
  if (s.trouble && now - s.trouble.at < 15 * 60_000) {
    const retry = s.trouble.attempt ? ` · retry ${s.trouble.attempt}${s.trouble.maxAttempts ? `/${s.trouble.maxAttempts}` : ''}` : '';
    return <div class="live warn">⚠ Connection or API problem{retry}: {s.trouble.message}</div>;
  }
  const p = s.pulse;
  if (p) {
    // Reported from inside the agent by Kvali's Claude Code plugin: no guessing needed.
    const t = fmtDuration(now - p.since);
    switch (p.phase) {
      case 'requesting':
        return <div class="live ok">● Waiting for the model · {t}</div>;
      case 'thinking':
        return <div class="live ok">● Thinking · {t}</div>;
      case 'writing':
        return <div class="live ok">● Writing the answer · {t}</div>;
      case 'tool-input':
        return <div class="live ok">● Preparing {p.label ?? 'a tool call'} · {t}</div>;
      case 'running':
        return <div class="live">◌ Running “{p.label ?? 'a tool'}” · {t}</div>;
      case 'needs-you':
        return <div class="live warn">! Needs you: {p.label ?? 'waiting for your answer'}</div>;
      case 'stalled':
        return (
          <div class="live warn">
            ⚠ No data from the API for {fmtDuration(now - (p.lastDataAt ?? p.since))}. The connection may be down; Claude Code retries on its own.
          </div>
        );
      case 'gone':
        return (
          <div class="live warn">
            ⚠ Claude Code stopped responding {fmtAgo(p.at, now)}: it was closed or froze. Check its window.
          </div>
        );
    }
  }
  if (quiet < 30_000) return <div class="live ok">● Active · last action {fmtAgo(s.updatedAt, now)}</div>;
  if (running) {
    // A bare tool name ("Shell", "Bash") says less than the command itself.
    const what = a!.kind === 'command' && a!.detail && /^(Shell|Bash)$/.test(a!.label) ? a!.detail : a!.label;
    const cut = what.length > 48 ? `${what.slice(0, 47)}…` : what;
    return (
      <div class="live">
        ◌ Waiting for “{cut}” to finish · {fmtDuration(now - a!.startedAt)}
      </div>
    );
  }
  if (quiet < QUIET_WARN_MS) return <div class="live muted">◌ Thinking · quiet for {fmtDuration(quiet)}</div>;
  return (
    <div class="live warn">
      ⚠ No output for {fmtDuration(quiet)} and nothing is running. It may be stuck or offline; check the agent’s window.
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

function Card({
  s,
  now,
  expanded,
  onToggle,
  showCost,
  autoPlans,
}: {
  s: AgentSession;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  showCost: boolean;
  autoPlans: boolean;
}) {
  const p = progressOf(s.tasks);
  const step = currentTask(s.tasks);
  const tok = sessionTokens(s);
  const todayTok = sessionTodayTokens(s, now);
  const showToday = tok !== undefined && todayTok !== undefined && todayTok < tok * 0.95;
  const ctxPct = s.context?.window ? Math.min(100, Math.round((s.context.used / s.context.window) * 100)) : undefined;
  const working = s.status === 'working';
  // Stale cards say it in the liveness line instead ("No output for 45m and nothing is running").
  const showDetail = !!s.statusDetail && !working && s.status !== 'stale';
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

      {p.total > 0 ? <ProgressBar p={p} moving={working} /> : working && <NoPlanBar s={s} now={now} autoPlans={autoPlans} />}

      {(working || s.status === 'stale') && <NowPanel s={s} step={step} now={now} />}

      <div class="meta">
        {tok !== undefined ? (
          <span title={`${tokenTitle(s)}${showToday ? ' · whole conversation, all days' : ''}`}>
            <strong>{fmtTokens(tok)}</strong> tokens
            {showToday && <span class="muted"> ({fmtTokens(todayTok)} today)</span>}
          </span>
        ) : (
          <span class="muted" title="This agent does not record token usage on disk">
            tokens n/a
          </span>
        )}
        {showCost && s.costUsd !== undefined && (
          <span class="muted" title="What these tokens would cost at API list prices. Subscriptions are not billed per token.">
            API value {fmtUsd(s.costUsd)}
          </span>
        )}
        {ctxPct !== undefined && (
          <span
            class="ctx"
            title={`Context window: ${fmtTokens(s.context!.used)} of ${fmtTokens(s.context!.window)} tokens used. This is everything the model holds in mind for this conversation. Near 100% the agent compacts the conversation into a summary and can lose details.`}
          >
            context <Meter value={ctxPct} label="Context window used" /> {ctxPct}%
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

function Group({
  g,
  now,
  ui,
  setUi,
  showCost,
  autoPlans,
}: {
  g: ProjectGroup;
  now: number;
  ui: UiState;
  setUi: (u: UiState) => void;
  showCost: boolean;
  autoPlans: boolean;
}) {
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
            {showCost && g.today.costUsd > 0 ? ` · API value ${fmtUsd(g.today.costUsd)}` : ''}
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
            autoPlans={autoPlans}
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

/** Black on white whatever the theme: phone cameras need the contrast. */
function Qr({ text, size = 168 }: { text: string; size?: number }) {
  const m = qrMatrix(text);
  const q = 2;
  const n = m.length + q * 2;
  let d = '';
  m.forEach((row, r) =>
    row.forEach((on, c) => {
      if (on) d += `M${c + q} ${r + q}h1v1h-1z`;
    }),
  );
  return (
    <svg class="qr" viewBox={`0 0 ${n} ${n}`} width={size} height={size} shape-rendering="crispEdges" role="img" aria-label="QR code that subscribes the ntfy app to Kvali's notifications">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const PHONE_EVENT_LABEL: Record<string, string> = {
  'needs-you': 'needs you',
  done: 'finished a long task',
  error: 'failed',
  stuck: 'went quiet or stopped responding',
  steps: 'finished a step',
};

function PhoneCard({ phone }: { phone: PhoneView }) {
  const events = phone.events.map((e) => PHONE_EVENT_LABEL[e] ?? e);
  const self = !/^https:\/\/ntfy\.sh$/.test(phone.server);
  return (
    <aside class="setup phone" aria-label="Phone notifications">
      <p class="setup-title">
        <b>Notifications on your phone</b>
      </p>
      <ol>
        <li>
          Install the free <b>ntfy</b> app (iPhone or Android).
        </li>
        <li>
          <b>Android:</b> scan the code. <b>iPhone:</b> in ntfy tap <b>+</b> and enter the topic below{self ? <> with server <code>{phone.server}</code></> : null}.
        </li>
      </ol>
      <div class="qr-wrap">
        <Qr text={phone.link} />
      </div>
      <p class="topic">
        <code>{phone.topic}</code>{' '}
        <button class="link" onClick={() => post({ type: 'copy', text: phone.topic })}>
          Copy
        </button>
      </p>
      <p class="muted small">
        You get a notification when an agent {events.length > 1 ? `${events.slice(0, -1).join(', ')} or ${events.at(-1)}` : events[0]}. The topic name is the key: keep it to yourself.
        {phone.details ? ' Notifications name the project and the step; never code or prompts.' : ' Notifications leave out project and step names.'}
      </p>
      <div class="setup-actions">
        <button class="btn" onClick={() => post({ type: 'command', command: 'kvali.phoneTest' })}>
          Send a test
        </button>
        <button class="link" onClick={() => post({ type: 'hidePhoneCard' })}>
          Done
        </button>
        <button class="link" onClick={() => post({ type: 'command', command: 'kvali.phoneOff' })}>
          Turn off
        </button>
      </div>
    </aside>
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
  const autoPlans = st.setup === 'on';
  const needsRepair = st.setup === 'on' && st.detected.includes('Claude Code') && st.claudeHooks !== 'installed';

  return (
    <main>
      <header class="summary">
        <div class="today">
          <span class="muted">Today</span> <strong>{fmtTokens(today.tokens)}</strong> tokens
          {st.showCost && today.priced && (
            <>
              {' '}
              · <span class="muted" title="What these tokens would cost at API list prices. Subscriptions are not billed per token.">API value {fmtUsd(today.costUsd)}</span>
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
      {st.setup === 'unset' && st.detected.length > 0 && (
        <aside class="setup">
          <p class="setup-title">
            <b>One click to finish:</b> alerts when an agent needs you, and a plan for every task.
          </p>
          <ul>
            {st.setupChanges.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p class="muted small">Your own settings stay as they are. Uninstalling Kvali removes all of it.</p>
          <div class="setup-actions">
            <button class="btn" onClick={() => post({ type: 'runSetup' })}>
              Turn on
            </button>
            <button class="link" onClick={() => post({ type: 'dismissSetup' })}>
              Not now
            </button>
          </div>
        </aside>
      )}
      {st.phoneCard && st.phone && <PhoneCard phone={st.phone} />}
      <Counts sessions={sessions} />
      <Limits sessions={sessions} now={now} />

      {groups.length === 0 ? <Empty hours={st.activeWindowHours} scope={st.scope} /> : groups.map((g) => <Group key={g.path ?? ''} g={g} now={now} ui={ui} setUi={setUi} showCost={st.showCost} autoPlans={autoPlans} />)}

      {needsRepair && (
        <aside class="tip">
          <p>
            <b>Claude Code hooks need a refresh.</b> Without them "Needs you" alerts and automatic plans are off.
          </p>
          <button class="btn" onClick={() => post({ type: 'runSetup' })}>
            Repair
          </button>
        </aside>
      )}

      {!st.phone && groups.length > 0 && (
        <p class="foot">
          <button class="link" onClick={() => post({ type: 'command', command: 'kvali.phoneSetup' })}>
            Get these alerts on your phone
          </button>
        </p>
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
