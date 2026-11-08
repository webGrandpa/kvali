import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtTokens, fmtUsd, fmtWork, weekRange, weekShareText, weekdayShort, type WeekStats } from '@kvali/core/browser';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();

import type { FromShare, ShareFormat as Format } from '../src/messages.ts';
const SIZE: Record<Format, [number, number]> = { landscape: [1200, 630], portrait: [1080, 1350] };

const FONT = `"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
const INK = '#f0f3f8';
const MUTED = '#8b93a7';
const SOFT = '#c7cede';
const BRAND = ['#e8875b', '#b58cf0', '#5aa2ff', '#6fd18a'];
const AGENT_COLOR: Record<string, string> = {
  'Claude Code': '#e8875b',
  Codex: '#b58cf0',
  'Gemini CLI': '#5aa2ff',
  Antigravity: '#6fd18a',
  Copilot: '#8fa8c8',
  Cline: '#5ec8d8',
  'Roo Code': '#f2b84b',
  'Kilo Code': '#e8d55b',
  OpenCode: '#d0d6e2',
};

function brandGradient(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  BRAND.forEach((c, i) => g.addColorStop(i / (BRAND.length - 1), c));
  return g;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Kvali's icon: the pulse line over a rounded square, drawn at `size` px. */
function logo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const k = size / 128;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  const bg = ctx.createLinearGradient(0, 0, 128, 128);
  bg.addColorStop(0, '#262a33');
  bg.addColorStop(1, '#15171c');
  roundRect(ctx, 0, 0, 128, 128, 28);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = brandGradient(ctx, 18, 0, 110, 0);
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(18, 54);
  for (const [px, py] of [
    [35, 54],
    [45, 32],
    [60, 74],
    [72, 44],
    [80, 54],
    [110, 54],
  ])
    ctx.lineTo(px!, py!);
  ctx.stroke();
  roundRect(ctx, 18, 86, 92, 16, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();
  BRAND.slice(0, 3).forEach((c, i) => {
    roundRect(ctx, 18 + i * 23, 86, 20, 16, 8);
    ctx.fillStyle = c;
    ctx.fill();
  });
  ctx.restore();
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = 'left'): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

/** The card: the week's agent work large, the counts beside it, a bar per day, where Kvali is. */
function draw(canvas: HTMLCanvasElement, w: WeekStats, format: Format, cost: boolean): void {
  const [W, H] = SIZE[format];
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const tall = format === 'portrait';
  const pad = tall ? 90 : 80;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1d2129');
  bg.addColorStop(1, '#0e1014');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (const [cx, cy, r, c] of [
    [W * 0.92, H * 0.08, W * 0.45, 'rgba(181,140,240,0.20)'],
    [W * 0.05, H * 0.98, W * 0.5, 'rgba(232,135,91,0.14)'],
  ] as const) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, c);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Every position, per format: the wide card reads left to right, the tall one top to bottom.
  const L = tall
    ? { logo: [pad, 74, 84], word: 44, sub: [250, 34], hero: [450, 190], heroSub: [515, 40], chips: [600, 28], stat: [720, 64, 762, 28], chart: [pad, W - pad * 2, 1110, 280, 1150, 26], foot: [1210, 1258, 1302, 28] }
    : { logo: [pad, 48, 64], word: 36, sub: [170, 28], hero: [300, 140], heroSub: [345, 30], chips: [398, 22], stat: [478, 44, 508, 20], chart: [760, W - pad - 760, 470, 260, 500, 18], foot: [548, 590, 590, 21] };

  // Header: the icon, the name, the week.
  const [lx, ly, ls] = L.logo as [number, number, number];
  logo(ctx, lx, ly, ls);
  text(ctx, 'Kvali', lx + ls + 20, ly + ls * 0.66, L.word, INK, 700);
  text(ctx, `My AI agents this week · ${weekRange(w)}`, pad, L.sub[0]!, L.sub[1]!, MUTED);

  // The headline: agent work.
  text(ctx, fmtWork(w.activeMs), pad, L.hero[0]!, L.hero[1]!, INK, 800);
  text(ctx, 'of agent work', pad, L.heroSub[0]!, L.heroSub[1]!, SOFT);

  // The agents, each in its color.
  let ax = pad;
  const [agentY, chipSize] = L.chips as [number, number];
  for (const a of w.agents.slice(0, 5)) {
    ctx.font = `600 ${chipSize}px ${FONT}`;
    const tw = ctx.measureText(a).width;
    if (ax + tw + 44 > (tall ? W - pad : 740)) break;
    roundRect(ctx, ax, agentY - chipSize - 6, tw + 44, chipSize + 20, (chipSize + 20) / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ax + 18, agentY - chipSize / 2 + 3, chipSize * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = AGENT_COLOR[a] ?? '#9aa4b8';
    ctx.fill();
    text(ctx, a, ax + 32, agentY, chipSize, INK, 600);
    ax += tw + 58;
  }

  // The counts.
  const stats: [string, string][] = [
    [String(w.tasksDone), w.tasksDone === 1 ? 'task done' : 'tasks done'],
    [fmtTokens(w.tokens), 'tokens'],
    ...(cost && w.priced && w.costUsd > 0 ? ([[fmtUsd(w.costUsd), 'API value']] as [string, string][]) : []),
    [String(w.sessions), w.sessions === 1 ? 'session' : 'sessions'],
  ];
  const [vy, vs, ly2, lsz] = L.stat as [number, number, number, number];
  const statW = tall ? (W - pad * 2) / stats.length : 166;
  stats.forEach(([v, l], i) => {
    const x = pad + i * statW;
    text(ctx, v, x, vy, vs, INK, 700);
    text(ctx, l, x, ly2, lsz, MUTED);
  });

  // A bar per day.
  const [chartX, chartW, chartBottom, chartH, labelY, labelSize] = L.chart as [number, number, number, number, number, number];
  const max = Math.max(1, ...w.days.map((d) => d.activeMs));
  const slot = chartW / w.days.length;
  const barW = slot * 0.62;
  w.days.forEach((d, i) => {
    const h = Math.max(6, (d.activeMs / max) * chartH);
    const x = chartX + i * slot + (slot - barW) / 2;
    roundRect(ctx, x, chartBottom - h, barW, h, Math.min(10, barW / 2));
    const g = ctx.createLinearGradient(0, chartBottom, 0, chartBottom - chartH);
    g.addColorStop(0, '#5aa2ff');
    g.addColorStop(1, '#b58cf0');
    ctx.fillStyle = d.activeMs ? g : 'rgba(255,255,255,0.10)';
    ctx.fill();
    const busiest = w.busiest?.day === d.day;
    text(ctx, weekdayShort(d.day), x + barW / 2, labelY, labelSize, busiest ? INK : MUTED, busiest ? 700 : 400, 'center');
  });

  // Footer: what Kvali is, and where.
  const [lineY, tagY, urlY, fs] = L.foot as [number, number, number, number];
  ctx.fillStyle = brandGradient(ctx, pad, 0, W - pad, 0);
  ctx.globalAlpha = 0.65;
  ctx.fillRect(pad, lineY, W - pad * 2, 2);
  ctx.globalAlpha = 1;
  text(ctx, 'See what your AI coding agents are doing', pad, tagY, fs, MUTED);
  if (tall) text(ctx, 'github.com/webGrandpa/kvali', pad, urlY, fs + 2, SOFT, 600);
  else text(ctx, 'github.com/webGrandpa/kvali', W - pad, urlY, fs, SOFT, 600, 'right');
}

function App() {
  const [stats, setStats] = useState<WeekStats>();
  const [format, setFormat] = useState<Format>('landscape');
  const [cost, setCost] = useState(false);
  const [post, setPost] = useState('');
  const [note, setNote] = useState('');
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.data?.type === 'stats') {
        setStats(e.data.stats as WeekStats);
        setPost(weekShareText(e.data.stats as WeekStats));
      }
    };
    window.addEventListener('message', on);
    vscode.postMessage({ type: 'ready' } satisfies FromShare);
    return () => window.removeEventListener('message', on);
  }, []);

  useEffect(() => {
    if (stats && ref.current) draw(ref.current, stats, format, cost);
  }, [stats, format, cost]);

  useEffect(() => {
    if (stats) setPost(weekShareText(stats, { cost }));
  }, [cost]);

  if (!stats) return <p class="muted">Counting this week’s work…</p>;
  const empty = stats.sessions === 0;

  const copyImage = () => {
    ref.current?.toBlob(async (blob) => {
      try {
        if (!blob) throw new Error('no image');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setNote('Image copied: paste it into your post.');
      } catch {
        vscode.postMessage({ type: 'copyFailed' } satisfies FromShare);
      }
    }, 'image/png');
  };

  return (
    <main>
      <header>
        <h1>Share your week</h1>
        <p class="muted">Counts only: no project names, titles or prompts are on the card.</p>
      </header>
      {empty ? <p class="note">No agent work in the last seven days yet: the card fills as your agents work.</p> : null}
      <div class="controls">
        <div class="seg" role="group" aria-label="Format">
          <button aria-pressed={format === 'landscape'} onClick={() => setFormat('landscape')}>
            Wide · 1200×630
          </button>
          <button aria-pressed={format === 'portrait'} onClick={() => setFormat('portrait')}>
            Tall · 1080×1350
          </button>
        </div>
        {stats.priced && stats.costUsd > 0 ? (
          <label class="check">
            <input type="checkbox" checked={cost} onChange={(e) => setCost((e.currentTarget as HTMLInputElement).checked)} />
            Show API value ({fmtUsd(stats.costUsd)})
          </label>
        ) : null}
      </div>
      <div class={`preview ${format}`}>
        <canvas ref={ref} aria-label="Your week as an image" />
      </div>
      <div class="actions">
        <button class="btn" onClick={() => vscode.postMessage({ type: 'save', dataUrl: ref.current!.toDataURL('image/png'), format } satisfies FromShare)}>
          Save PNG
        </button>
        <button class="btn secondary" onClick={copyImage}>
          Copy image
        </button>
      </div>
      <label class="post-label" for="post">
        Post text
      </label>
      <textarea id="post" rows={4} value={post} onInput={(e) => setPost((e.currentTarget as HTMLTextAreaElement).value)} />
      <div class="actions">
        <button class="btn secondary" onClick={() => vscode.postMessage({ type: 'copyText', text: post } satisfies FromShare)}>
          Copy text
        </button>
        <button class="btn secondary" onClick={() => vscode.postMessage({ type: 'open', url: `https://x.com/intent/post?text=${encodeURIComponent(post)}` } satisfies FromShare)}>
          Post on X
        </button>
        <button
          class="btn secondary"
          onClick={() => vscode.postMessage({ type: 'open', url: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(post)}` } satisfies FromShare)}
        >
          Post on LinkedIn
        </button>
      </div>
      <p class="muted small">{note || 'Save the image, then attach it to the post: X and LinkedIn open with the text filled in.'}</p>
    </main>
  );
}

render(<App />, document.getElementById('root')!);
