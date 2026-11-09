/**
 * "My agents this week": what every agent did over the last seven days, for a card people
 * can share. Counts only, from the per-day usage the adapters keep: no project names, no
 * titles, no prompts. Pure, so the webview draws the card from it.
 */
import { fmtTokens, fmtUsd } from './format.ts';
import type { AgentSession } from './model.ts';
import { cleanText } from './util/text.ts';

export interface WeekDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  activeMs: number;
  tokens: number;
  tasksDone: number;
}

export interface WeekStats {
  /** The seven local days ending today, oldest first. */
  days: WeekDay[];
  /** Sessions with any work in those days. */
  sessions: number;
  projects: number;
  /** Agents that worked, the busiest first. */
  agents: string[];
  activeMs: number;
  tasksDone: number;
  tokens: number;
  /** At API list prices; `priced` is false when no session's model has a known price. */
  costUsd: number;
  priced: boolean;
  /** The day with the most work. */
  busiest?: WeekDay;
}

export const WEEK_DAYS = 7;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The seven local days ending on `now`'s, oldest first. */
export function weekDays(now: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) out.push(localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()));
  return out;
}

export function weekStats(sessions: readonly AgentSession[], now: number): WeekStats {
  const days = weekDays(now).map((day) => ({ day, activeMs: 0, tokens: 0, tasksDone: 0 }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const since = new Date(`${days[0]!.day}T00:00:00`).getTime();
  const projects = new Set<string>();
  const agentWork = new Map<string, number>();
  let sessionsCount = 0;
  let costUsd = 0;
  let priced = false;
  for (const s of sessions) {
    let touched = false;
    let work = 0;
    for (const [day, u] of Object.entries(s.daily ?? {})) {
      const d = byDay.get(day);
      if (!d) continue;
      touched = true;
      d.activeMs += u.activeMs ?? 0;
      d.tokens += u.tokens;
      d.tasksDone += u.tasksDone ?? 0;
      costUsd += u.costUsd;
      work += (u.activeMs ?? 0) + 1;
    }
    // Agents that keep no per-day usage still count when they worked this week.
    if (!touched && !s.daily && s.updatedAt >= since) touched = true;
    if (!touched) continue;
    sessionsCount += 1;
    if (s.projectPath) projects.add(s.projectPath);
    agentWork.set(s.agentLabel, (agentWork.get(s.agentLabel) ?? 0) + work);
    if (s.costUsd !== undefined) priced = true;
  }
  const sum = (k: 'activeMs' | 'tokens' | 'tasksDone') => days.reduce((n, d) => n + d[k], 0);
  const busiest = [...days].sort((a, b) => b.activeMs - a.activeMs)[0];
  return {
    days,
    sessions: sessionsCount,
    projects: projects.size,
    agents: [...agentWork].sort((a, b) => b[1] - a[1]).map(([label]) => label),
    activeMs: sum('activeMs'),
    tasksDone: sum('tasksDone'),
    tokens: sum('tokens'),
    costUsd,
    priced,
    busiest: busiest && busiest.activeMs > 0 ? busiest : undefined,
  };
}

/** Agent work as a headline: "31 h", "3.5 h", "45 min". */
export function fmtWork(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = ms / 3_600_000;
  return h < 10 ? `${(Math.round(h * 10) / 10).toString()} h` : `${Math.round(h)} h`;
}

/** "Mon", "Tue", … for a `YYYY-MM-DD` day, in English (the card is English). */
export function weekdayShort(day: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${day}T12:00:00`).getDay()]!;
}

/** "Oct 31 – Nov 6". */
export function weekRange(w: Pick<WeekStats, 'days'>): string {
  const f = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(w.days[0]!.day)} – ${f(w.days[w.days.length - 1]!.day)}`;
}

export const KVALI_URL = 'https://github.com/webGrandpa/kvali';

/** A post to go with the card: the numbers in words, and where Kvali is. */
export function weekShareText(w: WeekStats, opts: { cost?: boolean } = {}): string {
  const facts = [
    w.activeMs >= 60_000 ? `${fmtWork(w.activeMs)} of agent work` : undefined,
    w.tasksDone ? `${w.tasksDone} task${w.tasksDone === 1 ? '' : 's'} done` : undefined,
    w.tokens ? `${fmtTokens(w.tokens)} tokens` : undefined,
    opts.cost && w.priced && w.costUsd > 0 ? `${fmtUsd(w.costUsd)} at API prices` : undefined,
  ].filter(Boolean);
  const who = w.agents.length ? ` with ${w.agents.length === 1 ? w.agents[0] : `${w.agents.slice(0, -1).join(', ')} and ${w.agents[w.agents.length - 1]}`}` : '';
  return `My AI coding agents this week${who}: ${facts.join(', ') || 'getting started'}.\n\nTracked with Kvali, an open-source progress bar for AI agents: ${KVALI_URL}`;
}

/** Text for the SVG: no characters XML forbids, the markup characters escaped. */
const esc = (t: string) =>
  cleanText(t, 300).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * The card as SVG (the CLI's version; the editor draws the same card as a PNG). 1200×630:
 * the work time large, the other counts beside it, a bar per day.
 */
export function weekSvg(w: WeekStats, opts: { cost?: boolean } = {}): string {
  const W = 1200;
  const H = 630;
  const font = `font-family="Inter, 'Segoe UI', -apple-system, Helvetica, Arial, sans-serif"`;
  const max = Math.max(1, ...w.days.map((d) => d.activeMs));
  const bars = w.days
    .map((d, i) => {
      const h = Math.round((d.activeMs / max) * 150);
      const x = 760 + i * 58;
      return `<rect x="${x}" y="${470 - h}" width="38" height="${Math.max(4, h)}" rx="8" fill="url(#pulse)" opacity="${d.activeMs ? 1 : 0.25}"/>
<text x="${x + 19}" y="500" text-anchor="middle" font-size="18" fill="#8b93a7" ${font}>${weekdayShort(d.day)}</text>`;
    })
    .join('\n');
  const stats = [
    [String(w.tasksDone), 'tasks done'],
    [fmtTokens(w.tokens), 'tokens'],
    ...(opts.cost && w.priced && w.costUsd > 0 ? [[fmtUsd(w.costUsd), 'API value']] : []),
    [String(w.agents.length), w.agents.length === 1 ? 'agent' : 'agents'],
  ]
    .map(([v, l], i) => {
      const x = 80 + i * 165;
      return `<text x="${x}" y="470" font-size="44" font-weight="700" fill="#f0f3f8" ${font}>${esc(v!)}</text><text x="${x}" y="502" font-size="20" fill="#8b93a7" ${font}>${esc(l!)}</text>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2129"/><stop offset="1" stop-color="#0e1014"/></linearGradient>
<linearGradient id="pulse" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5aa2ff"/><stop offset="1" stop-color="#b58cf0"/></linearGradient>
<linearGradient id="line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e8875b"/><stop offset="0.35" stop-color="#b58cf0"/><stop offset="0.7" stop-color="#5aa2ff"/><stop offset="1" stop-color="#6fd18a"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<g transform="translate(80 64) scale(0.5)"><rect width="128" height="128" rx="28" fill="#262a33"/><path d="M18 54h17l10-22 15 42 12-30 8 10h30" fill="none" stroke="url(#line)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="160" y="108" font-size="34" font-weight="700" fill="#f0f3f8" ${font}>Kvali</text>
<text x="80" y="200" font-size="28" fill="#8b93a7" ${font}>My AI agents this week · ${esc(weekRange(w))}</text>
<text x="80" y="330" font-size="128" font-weight="800" fill="#f0f3f8" ${font}>${esc(fmtWork(w.activeMs))}</text>
<text x="80" y="380" font-size="30" fill="#c7cede" ${font}>of agent work${w.agents.length ? ` · ${esc(w.agents.join(' · '))}` : ''}</text>
${stats}
${bars}
<rect x="80" y="560" width="1040" height="2" fill="url(#line)" opacity="0.6"/>
<text x="80" y="600" font-size="22" fill="#8b93a7" ${font}>See what your AI agents are doing · github.com/webGrandpa/kvali</text>
</svg>
`;
}
