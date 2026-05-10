/**
 * pricing.ts — single source of truth for MotionMax pricing.
 *
 * B-NEW-21 (2026-05-10): Mirrors the Agent Opus pricing structure with
 * MotionMax's existing "Creator" + "Studio" tier names. The previous
 * pricing ($11/mo Creator at 500 cr) had a -$3.80 per-cinematic-short
 * contribution margin; the new ladder fixes that while preserving the
 * brand-recognised tier names.
 *
 * EVERY price string, credit count, slot allotment, and Stripe ID
 * lookup MUST resolve through this file. Don't duplicate price strings
 * elsewhere — the audit gate at the end of this module relies on grep
 * across the repo finding zero hard-coded numbers outside this file.
 *
 * Stripe IDs are resolved at run-time from `process.env` (Node) or
 * `import.meta.env` (Vite/Astro) via tier-and-mode-aware getters. Run
 * `node scripts/sync-stripe-products.mjs` to provision the catalog and
 * paste the printed env-var block into .env.local + Vercel.
 */

// ─────────────────────────────────────────────────────────────────────
// Promo window — drives the "first 3 months" discount on monthly subs.
// Mirrored on the marketing site via @/config/pricing alias (see
// marketing/tsconfig.json paths). Bump the date here once the promo
// rolls off and the banner / strikethrough disappears automatically.
// ─────────────────────────────────────────────────────────────────────

export const LIMITED_TIME_PROMO_END = '2026-07-15';

export const PROMO_BANNER_COPY =
  'LIMITED-TIME OFFER · Up to 34% off your first 3 months. Ends July 15.';

export function isPromoActive(now: number = Date.now()): boolean {
  return now < new Date(LIMITED_TIME_PROMO_END).getTime();
}

// ─────────────────────────────────────────────────────────────────────
// Stripe-mode aware env reader.
//
// In React/Vite + Astro builds, env values arrive via import.meta.env
// (prefixed VITE_ to be exposed). In Node scripts (sync-stripe-products,
// vitest, etc.), process.env wins. Resolve at call time so Vite's
// tree-shaker doesn't snapshot at module-load.
// ─────────────────────────────────────────────────────────────────────

type StripeMode = 'test' | 'live';

function readEnv(key: string): string | undefined {
  // Node / Deno / scripts.
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  // Vite / Astro browser bundle. import.meta.env keys must be prefixed
  // VITE_ to be exposed — we mirror each STRIPE_* var as VITE_STRIPE_*
  // in .env.local. Try the VITE_ form first, then the bare form.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (import.meta as any);
    if (meta && meta.env) {
      return meta.env[`VITE_${key}`] ?? meta.env[key];
    }
  } catch {
    // import.meta unsupported in this runtime — fall through.
  }
  return undefined;
}

function getStripeMode(): StripeMode {
  const m = (readEnv('STRIPE_MODE') ?? 'test').toLowerCase();
  return m === 'live' ? 'live' : 'test';
}

function suffix(): 'TEST' | 'LIVE' {
  return getStripeMode() === 'live' ? 'LIVE' : 'TEST';
}

// ── Subscription price-id getters ────────────────────────────────────

export function getCreatorMonthlyPriceId(): string | undefined {
  return readEnv(`STRIPE_PRICE_CREATOR_MONTHLY_${suffix()}`);
}
export function getCreatorYearlyPriceId(): string | undefined {
  return readEnv(`STRIPE_PRICE_CREATOR_YEARLY_${suffix()}`);
}
export function getStudioMonthlyPriceId(): string | undefined {
  return readEnv(`STRIPE_PRICE_STUDIO_MONTHLY_${suffix()}`);
}
export function getStudioYearlyPriceId(): string | undefined {
  return readEnv(`STRIPE_PRICE_STUDIO_YEARLY_${suffix()}`);
}

// ── Promo-coupon getters (3-month repeating discount) ────────────────

export function getCreatorPromoCouponId(): string | undefined {
  return readEnv(`STRIPE_COUPON_CREATOR_PROMO_${suffix()}`);
}
export function getStudioPromoCouponId(): string | undefined {
  return readEnv(`STRIPE_COUPON_STUDIO_PROMO_${suffix()}`);
}

// ── Top-up pack price-id getters ─────────────────────────────────────

export type TopUpSku = 'quick' | 'plus' | 'power' | 'studio' | 'pro';

export function getTopUpPriceId(sku: TopUpSku): string | undefined {
  return readEnv(`STRIPE_PRICE_TOPUP_${sku.toUpperCase()}_${suffix()}`);
}

// ─────────────────────────────────────────────────────────────────────
// Plan catalog. Display strings, numeric prices, and entitlement
// counts. Free has no Stripe IDs (it's the implicit no-checkout state).
// ─────────────────────────────────────────────────────────────────────

export interface PlanDefinition {
  /** Stable internal id — used in DB rows + analytics. */
  id: 'free' | 'creator' | 'studio';
  /** Customer-facing tier name (preserved across the B-NEW-21 reprice). */
  name: string;
  blurb: string;

  // Price points — NUMBERS in USD, not strings. Format with formatUsd().
  /** Yearly plan, displayed as a monthly-equivalent ($X/mo billed annually). */
  price_yearly_monthly: number;
  /** Yearly plan total billed up-front. */
  price_yearly_total: number;
  /** Promo monthly price for first 3 months — only when isPromoActive(). */
  price_monthly_first3: number;
  /** Standard monthly price after promo (= "regular" monthly). */
  price_monthly_after: number;

  // Entitlements.
  credits_monthly: number;
  credits_yearly: number;
  /** Daily refresh credits added on top of subscription bucket. */
  daily_credits: number;
  voice_clones: number;
  automation_slots: number;
  watermark_removal: boolean;
  priority_queue: boolean;

  // Stripe IDs — resolved at call time so STRIPE_MODE swaps cleanly.
  getMonthlyPriceId(): string | undefined;
  getYearlyPriceId(): string | undefined;
  getPromoCouponId(): string | undefined;
}

export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    blurb: 'Full editor access. No card required.',
    price_yearly_monthly: 0,
    price_yearly_total: 0,
    price_monthly_first3: 0,
    price_monthly_after: 0,
    credits_monthly: 60,
    credits_yearly: 60 * 12,
    daily_credits: 100,
    voice_clones: 0,
    automation_slots: 0,
    watermark_removal: false,
    priority_queue: false,
    getMonthlyPriceId: () => undefined,
    getYearlyPriceId: () => undefined,
    getPromoCouponId: () => undefined,
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    blurb: 'For content creators and social media.',
    price_yearly_monthly: 14.5,
    price_yearly_total: 174,
    price_monthly_first3: 19,
    price_monthly_after: 29,
    credits_monthly: 500,
    credits_yearly: 6000,
    daily_credits: 200,
    voice_clones: 1,
    automation_slots: 1,
    watermark_removal: true,
    priority_queue: false,
    getMonthlyPriceId: getCreatorMonthlyPriceId,
    getYearlyPriceId: getCreatorYearlyPriceId,
    getPromoCouponId: getCreatorPromoCouponId,
  },
  studio: {
    id: 'studio',
    name: 'Studio',
    blurb: 'For agencies and professional teams.',
    price_yearly_monthly: 64.5,
    price_yearly_total: 774,
    price_monthly_first3: 90,
    price_monthly_after: 129,
    credits_monthly: 2000,
    credits_yearly: 24000,
    daily_credits: 200,
    voice_clones: 5,
    automation_slots: 5,
    watermark_removal: true,
    priority_queue: true,
    getMonthlyPriceId: getStudioMonthlyPriceId,
    getYearlyPriceId: getStudioYearlyPriceId,
    getPromoCouponId: getStudioPromoCouponId,
  },
} as const satisfies Record<'free' | 'creator' | 'studio', PlanDefinition>;

export type PlanId = keyof typeof PLANS;

// ─────────────────────────────────────────────────────────────────────
// Multi-pack ladder (1×–6× of base allotment).
//
// In Stripe this is implemented as `quantity` on the subscription item,
// not a separate SKU per multiplier — the sync script can optionally
// emit per-multiplier SKUs via --no-skip-multipacks for finance teams
// who prefer one-line-item-per-pack reporting.
// ─────────────────────────────────────────────────────────────────────

export const MULTIPACK_MIN = 1;
export const MULTIPACK_MAX = 6;
export type MultipackMultiplier = 1 | 2 | 3 | 4 | 5 | 6;

export function multipackLadder(base: number): number[] {
  return Array.from({ length: MULTIPACK_MAX }, (_, i) => base * (i + 1));
}

/** Convenience views for UI rendering — stable arrays for memo deps. */
export const CREATOR_MONTHLY_LADDER = multipackLadder(PLANS.creator.credits_monthly);
export const CREATOR_YEARLY_LADDER = multipackLadder(PLANS.creator.credits_yearly);
export const STUDIO_MONTHLY_LADDER = multipackLadder(PLANS.studio.credits_monthly);
export const STUDIO_YEARLY_LADDER = multipackLadder(PLANS.studio.credits_yearly);

// ─────────────────────────────────────────────────────────────────────
// Top-up packs. One-time purchases. Available to ALL tiers (incl Free).
// Per ToS §6, top-up credits NEVER expire.
// ─────────────────────────────────────────────────────────────────────

export interface TopUpPack {
  sku: TopUpSku;
  /** Display label (capitalised). */
  label: string;
  credits: number;
  price_usd: number;
  per_credit: number;
  getPriceId(): string | undefined;
}

export const TOP_UP_PACKS: TopUpPack[] = [
  { sku: 'quick',  label: 'Quick',  credits: 250,   price_usd: 14.99,  per_credit: 0.060, getPriceId: () => getTopUpPriceId('quick') },
  { sku: 'plus',   label: 'Plus',   credits: 500,   price_usd: 24.99,  per_credit: 0.050, getPriceId: () => getTopUpPriceId('plus') },
  { sku: 'power',  label: 'Power',  credits: 1000,  price_usd: 44.99,  per_credit: 0.045, getPriceId: () => getTopUpPriceId('power') },
  { sku: 'studio', label: 'Studio', credits: 2500,  price_usd: 99.99,  per_credit: 0.040, getPriceId: () => getTopUpPriceId('studio') },
  { sku: 'pro',    label: 'Pro',    credits: 5000,  price_usd: 179.99, per_credit: 0.036, getPriceId: () => getTopUpPriceId('pro') },
];

// ─────────────────────────────────────────────────────────────────────
// Display helpers. Keep this module string-agnostic where possible so
// i18n can swap formatters without touching plan data.
// ─────────────────────────────────────────────────────────────────────

/** "$29" or "$14.50" — drops the trailing .00 like Stripe Checkout does. */
export function formatUsd(amount: number): string {
  if (Number.isInteger(amount)) return `$${amount}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * Yearly savings vs. paying-monthly-after-promo. Used for the "Save X%"
 * badge in the billing toggle.
 */
export function yearlySavingsPercent(plan: Exclude<PlanId, 'free'>): number {
  const p = PLANS[plan];
  const monthlyAnnualised = p.price_monthly_after * 12;
  if (monthlyAnnualised === 0) return 0;
  return Math.round((1 - p.price_yearly_total / monthlyAnnualised) * 100);
}

/**
 * The first-3-months promo discount as a percentage off the after-promo
 * monthly price. 34% for Creator, ~30% for Studio (per locked spec).
 * Used by the strike-through helper and the Stripe coupon `percent_off`.
 */
export function monthlyPromoPercentOff(plan: Exclude<PlanId, 'free'>): number {
  const p = PLANS[plan];
  if (p.price_monthly_after === 0) return 0;
  return Math.round((1 - p.price_monthly_first3 / p.price_monthly_after) * 100);
}
