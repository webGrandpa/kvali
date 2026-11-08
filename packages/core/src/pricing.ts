/**
 * Cost estimation at API list prices.
 *
 * Built-in prices cover Anthropic models (source: platform.claude.com/docs/en/about-claude/pricing,
 * checked 2026-10-31). Prices for any other model can be supplied by the user via
 * `customPrices` (the VS Code setting `kvali.pricing`), keyed by a model id or a `*` glob.
 *
 * Subscription users are not billed per token; for them the number is an
 * "API-equivalent" estimate, which is still a useful relative measure.
 */

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. Defaults to 1.25 × input. */
  cacheWrite5m?: number;
  /** 1-hour cache write. Defaults to 2 × input. */
  cacheWrite1h?: number;
  /** Higher tier applied when one request's prompt exceeds `threshold` tokens. */
  longPrompt?: { threshold: number } & Omit<ModelPrice, 'longPrompt'>;
  /** Multiplier applied when the request ran in fast mode. */
  fastMultiplier?: number;
}

export interface PricedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  speed?: string;
  inferenceGeo?: string;
}

const p = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): ModelPrice => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
});

const OPUS_45_PLUS = p(5, 6.25, 10, 0.5, 25);
const OPUS_LEGACY = p(15, 18.75, 30, 1.5, 75);
const SONNET_4 = p(3, 3.75, 6, 0.3, 15);

/** Keys are `family-major[-minor]`, see `anthropicModelKey`. */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  'fable-5-1': p(10, 12.5, 20, 0.25, 50),
  'mythos-5-1': p(10, 12.5, 20, 0.25, 50),
  'opus-5-5': { ...p(4, 5, 8, 0.2, 20), fastMultiplier: 2 },
  'sonnet-5-5': p(2, 2.5, 4, 0.1, 10),
  'haiku-5-5': {
    ...p(0.1, 0.125, 0.2, 0.01, 0.5),
    longPrompt: { threshold: 100_000, ...p(0.5, 0.625, 1, 0.05, 2.5) },
  },
  'fable-5': p(10, 12.5, 20, 1, 50),
  'mythos-5': p(10, 12.5, 20, 1, 50),
  'opus-5': { ...OPUS_45_PLUS, fastMultiplier: 2 },
  'opus-4-8': { ...OPUS_45_PLUS, fastMultiplier: 2 },
  'opus-4-7': OPUS_45_PLUS,
  'opus-4-6': OPUS_45_PLUS,
  'opus-4-5': OPUS_45_PLUS,
  'opus-4-1': OPUS_LEGACY,
  'opus-4': OPUS_LEGACY,
  'sonnet-5': p(2, 2.5, 4, 0.2, 10),
  'sonnet-4-6': SONNET_4,
  'sonnet-4-5': SONNET_4,
  'sonnet-4': SONNET_4,
  'haiku-4-5': p(1, 1.25, 2, 0.1, 5),
  'haiku-3-5': p(0.8, 1, 1.6, 0.08, 4),
  'sonnet-3-7': SONNET_4,
  'sonnet-3-5': SONNET_4,
  'opus-3': OPUS_LEGACY,
  'haiku-3': p(0.25, 0.3, 0.5, 0.03, 1.25),
};

/**
 * Normalizes Anthropic model ids from the API, Bedrock and Vertex into a pricing key:
 *   claude-opus-4-5-20251101 → opus-4-5      claude-3-5-haiku-20241022 → haiku-3-5
 *   us.anthropic.claude-sonnet-4-6-v1:0 → sonnet-4-6      claude-opus-5-5[1m] → opus-5-5
 *   anthropic/claude-sonnet-4.5 → sonnet-4-5
 */
export function anthropicModelKey(model: string): string | undefined {
  let m = model.toLowerCase();
  const at = m.indexOf('claude');
  if (at === -1) return undefined;
  // Some tools write versions with a dot (`claude-sonnet-4.5`, `claude-opus-4.8-fast`).
  m = m.slice(at).replace(/\[[^\]]*\]/g, '').replace(/@.*$/, '').replace(/(\d)\.(\d)/g, '$1-$2');
  let r = /^claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=-|$|:)/.exec(m);
  if (r) return `${r[1]}-${r[2]}${r[3] ? `-${r[3]}` : ''}`;
  r = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/.exec(m);
  if (r) return `${r[3]}-${r[1]}${r[2] ? `-${r[2]}` : ''}`;
  return undefined;
}

function isClaude46OrLater(key: string): boolean {
  const r = /^(\w+)-(\d+)(?:-(\d+))?$/.exec(key);
  if (!r) return false;
  const major = Number(r[2]);
  const minor = Number(r[3] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export class Pricing {
  private readonly custom: { re: RegExp; price: ModelPrice }[];

  constructor(customPrices: Record<string, Partial<ModelPrice>> = {}) {
    this.custom = Object.entries(customPrices)
      .filter(([, v]) => v && typeof v.input === 'number' && typeof v.output === 'number')
      .map(([k, v]) => ({
        re: globToRegExp(k),
        price: { cacheRead: 0, ...v } as ModelPrice,
      }));
  }

  find(model: string | undefined): { price: ModelPrice; key: string } | undefined {
    if (!model) return undefined;
    for (const c of this.custom) if (c.re.test(model)) return { price: c.price, key: model };
    const key = anthropicModelKey(model);
    if (key && ANTHROPIC_PRICES[key]) return { price: ANTHROPIC_PRICES[key], key };
    return undefined;
  }

  /** Cost of one request in USD, or `undefined` when the model's price is unknown. */
  cost(model: string | undefined, u: PricedUsage): number | undefined {
    const found = this.find(model);
    if (!found) return undefined;
    let price: Omit<ModelPrice, 'longPrompt'> = found.price;
    const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    if (found.price.longPrompt && prompt > found.price.longPrompt.threshold) price = found.price.longPrompt;

    const cw5 = price.cacheWrite5m ?? price.input * 1.25;
    const cw1h = price.cacheWrite1h ?? price.input * 2;
    let usd =
      (u.input * price.input +
        u.output * price.output +
        u.cacheRead * price.cacheRead +
        u.cacheWrite5m * cw5 +
        u.cacheWrite1h * cw1h) /
      1_000_000;

    if (u.speed === 'fast') usd *= found.price.fastMultiplier ?? 2;
    if (u.inferenceGeo === 'us' && isClaude46OrLater(found.key)) usd *= 1.1;
    return usd;
  }
}
