/**
 * A turn that ended on a plan's usage limit. Claude Code writes it as an API error message in the
 * model's place, in its own words, and usually with the limit's details beside it:
 *
 *   { "type": "assistant", "isApiErrorMessage": true, "error": "rate_limit",
 *     "apiError": "usage_limit_reached",
 *     "apiErrorParams": { "rate_limit_info": { "rateLimitType": "five_hour", "resetsAt": 1795705200 } },
 *     "message": { "model": "<synthetic>", "content": [{ "type": "text",
 *       "text": "You've hit your 5-hour limit · resets 7pm (Asia/Tbilisi)" }] } }
 *
 * Older versions wrote "Claude AI usage limit reached|<reset, in Unix seconds>".
 */

export interface LimitStop {
  /** When the limit stopped the turn. */
  at: number;
  /** In Claude Code's words: "5-hour limit", "weekly limit", "Fable limit", ... */
  limit: string;
  /** When the limit resets, when that is known. */
  resetsAt?: number;
}

const LIMIT_TEXT = /^(?:You've hit your|You've reached your|You're out of usage credits|Claude AI usage limit reached)/i;

/** Claude Code's names for its limits (`rate_limit_info.rateLimitType`). */
const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  seven_day_overage_included: 'Fable limit',
  overage: 'usage credit limit',
};

const toMs = (v: number) => (v < 1e12 ? v * 1000 : v);

/** The usage limit an API error message reports, if it reports one. */
export function limitStopOf(record: Record<string, any>, text: string, at: number): LimitStop | undefined {
  const t = text.trim();
  const isLimit = record.apiError === 'usage_limit_reached' || LIMIT_TEXT.test(t) || (record.error === 'rate_limit' && /\blimit\b/i.test(t) && !/rate limited/i.test(t));
  if (!isLimit) return undefined;
  const info = record.apiErrorParams?.rate_limit_info;
  let resetsAt = typeof info?.resetsAt === 'number' && info.resetsAt > 0 ? toMs(info.resetsAt) : undefined;
  resetsAt ??= parseResetsAt(t, at);
  const named = typeof info?.rateLimitType === 'string' ? LIMIT_NAMES[info.rateLimitType] : undefined;
  const said = /^You've (?:hit|reached) your (.+?)(?:\s+·|\.|$)/i.exec(t)?.[1]?.trim();
  return { at, limit: named ?? (said && said.length <= 40 ? said : 'usage limit'), resetsAt };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** The wall clock in a time zone at instant `t`. */
function wall(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    mo: Number(get('month')) - 1,
    d: Number(get('day')),
    h: Number(get('hour')) % 24,
    mi: Number(get('minute')),
    wd: DAYS.indexOf(get('weekday').slice(0, 3).toLowerCase()),
  };
}

/** The instant a wall-clock time in a time zone stands for. */
function instant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const want = Date.UTC(y, mo, d, h, mi);
  let t = want;
  for (let i = 0; i < 3; i += 1) {
    const w = wall(t, tz);
    const diff = want - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    if (diff === 0) break;
    t += diff;
  }
  return t;
}

/**
 * When a limit message says the limit resets: "resets 7pm (Asia/Tbilisi)", "resets 7:30pm",
 * "resets Dec 2, 9am", "resets Tue 10am", "resets in 2h 15m", or the old "…|1754046000".
 * A time of day means its next occurrence after `at`.
 */
export function parseResetsAt(text: string, at: number): number | undefined {
  const legacy = /usage limit reached\|(\d{10,13})/i.exec(text);
  if (legacy) return toMs(Number(legacy[1]));
  const rel = /\bresets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) return at + ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000;
  const m =
    /\bresets?\s+(?:on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return undefined;
  let h = Number(m[4]);
  const mi = Number(m[5] ?? 0);
  const ampm = m[6]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (!m[5] || h > 23) {
    // A bare number without am/pm or minutes is not a time.
    return undefined;
  }
  if (mi > 59) return undefined;
  const tz = validZone(m[7]?.trim()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const now = wall(at, tz);
  if (m[2]) {
    const mo = MONTHS.indexOf(m[2].toLowerCase());
    const d = Number(m[3]);
    let t = instant(now.y, mo, d, h, mi, tz);
    if (t < at - 86_400_000) t = instant(now.y + 1, mo, d, h, mi, tz);
    return t;
  }
  let days = 0;
  if (m[1]) days = (DAYS.indexOf(m[1].toLowerCase()) - now.wd + 7) % 7;
  let t = instant(now.y, now.mo, now.d + days, h, mi, tz);
  if (t <= at) t = instant(now.y, now.mo, now.d + days + (m[1] ? 7 : 1), h, mi, tz);
  return t;
}
