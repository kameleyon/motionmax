/**
 * Per-tier provider key pools — config-driven resolver (Phase 4, SCAFFOLD).
 *
 * STATUS: FLAGGED OFF by default (FLAG_PROVIDER_KEY_POOLS / DB
 * feature_flag `provider_key_pools`, default false). When OFF, every
 * resolver returns the EXACT SAME process.env.X value the hot provider
 * services read today — zero behavior change. The hot services do NOT
 * import this yet; this is a drop-in resolver they can adopt later with
 * a one-line change (see "ADOPTION" below).
 *
 * WHY: at GA we want to isolate provider quota/billing by account tier so
 * a burst of `free` traffic can't exhaust the key that `studio` jobs run
 * on. Rather than rewire each service now, we ship a resolver that:
 *   - OFF  → base key only (today's behavior, exactly)
 *   - ON   → an ordered per-tier pool from env, falling back to the base
 *            key, modeled on geminiNative.listGoogleApiKeys() + the
 *            opts.apiKey override precedent.
 *
 * ENV (only consulted when the flag is ARMED):
 *   <BASE>_STUDIO    e.g. HYPEREAL_API_KEY_STUDIO     (highest priority for tier=studio)
 *   <BASE>_CREATOR   e.g. HYPEREAL_API_KEY_CREATOR
 *   <BASE>_FREE      e.g. HYPEREAL_API_KEY_FREE
 *   <BASE>           e.g. HYPEREAL_API_KEY            (always the final fallback)
 *
 * The pool for a tier is [tier-specific key, base key], de-duplicated and
 * empties dropped. studio→creator→free do NOT cascade into each other's
 * pools (a tier either has its own key or falls straight to base) so a
 * misconfigured studio key can't silently borrow the free pool.
 *
 * ADOPTION (later, one line per call site — NOT done in this scaffold):
 *   import { resolveProviderKey } from "../lib/providerKeys.js";
 *   const apiKey = await resolveProviderKey('hypereal', { tier })
 *                  ?? process.env.HYPEREAL_API_KEY;
 *   // ^ resolveProviderKey already returns the base key when the flag is
 *   //   OFF, so the `?? process.env.HYPEREAL_API_KEY` is belt-and-braces
 *   //   for the (impossible-when-configured) empty-string case.
 *
 * See docs/api/provider-isolation.md for the operator-facing guide.
 */

import { isEnabled } from "./featureFlags.js";

/** Providers whose keys can be pooled per tier. */
export type ProviderKeyName =
  | "hypereal"
  | "hypereal_image"
  | "openrouter"
  | "atlascloud"
  | "fish";

/** Account tiers (mirrors accounts.tier). */
export type AccountTier = "free" | "creator" | "studio";

export interface ResolveProviderKeyOptions {
  /** Account tier driving pool selection. Absent → base key only. */
  tier?: AccountTier;
}

/**
 * Base env var name each provider reads TODAY (the flag-OFF answer and the
 * final fallback rung when the flag is ON). Keep in lockstep with the
 * scattered process.env reads documented in providerKeysBanner.ts.
 */
const BASE_ENV: Record<ProviderKeyName, string> = {
  hypereal: "HYPEREAL_API_KEY",
  hypereal_image: "HYPEREALIMAGE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  atlascloud: "ATLASCLOUD_API_KEY",
  fish: "FISH_AUDIO_API_KEY",
};

/** Per-tier env suffix. */
const TIER_SUFFIX: Record<AccountTier, string> = {
  free: "_FREE",
  creator: "_CREATOR",
  studio: "_STUDIO",
};

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Build the ordered, de-duplicated key pool for a provider+tier *as if the
 * flag were ON*. Pure (no flag read) so it can be unit-tested and reused by
 * resolveProviderKey. Order: [tier-specific key, base key].
 */
function buildPool(provider: ProviderKeyName, tier?: AccountTier): string[] {
  const base = BASE_ENV[provider];
  const ordered: Array<string | undefined> = [];

  if (tier) {
    ordered.push(readEnv(`${base}${TIER_SUFFIX[tier]}`));
  }
  ordered.push(readEnv(base));

  const seen = new Set<string>();
  const pool: string[] = [];
  for (const k of ordered) {
    if (k && !seen.has(k)) {
      seen.add(k);
      pool.push(k);
    }
  }
  return pool;
}

/**
 * The ordered key pool for a provider+tier, honoring the flag.
 *
 * - Flag OFF (default): always [base key] (the single value used today),
 *   regardless of tier — tier-specific env vars are ignored entirely.
 * - Flag ON: [tier-specific key (if set), base key], de-duplicated.
 *
 * Returns [] only when the base key itself is unset/empty (and, when ON,
 * no tier key is set either) — same "not configured" state callers handle
 * today when process.env.X is empty.
 *
 * Use this when a caller wants to iterate the pool (e.g. retry the next
 * key after a 403, mirroring callGeminiWithKeyRotation). Most callers want
 * resolveProviderKey (the first/highest-priority key) instead.
 */
export async function listProviderKeyPool(
  provider: ProviderKeyName,
  tier?: AccountTier,
): Promise<string[]> {
  const armed = await isEnabled("provider_key_pools", false);
  if (!armed) {
    const base = readEnv(BASE_ENV[provider]);
    return base ? [base] : [];
  }
  return buildPool(provider, tier);
}

/**
 * Resolve the highest-priority provider API key for the given tier.
 *
 * Drop-in for the scattered `process.env.X` reads. Behavior:
 *   - Flag OFF (default): returns process.env.<BASE> verbatim (or "" when
 *     unset) — identical to today.
 *   - Flag ON: returns the tier-specific key if configured, else the base
 *     key, else "".
 *
 * Returns "" (not undefined) when nothing is configured so callers can do
 * a simple truthiness check exactly like they do on process.env.X today;
 * the documented adoption snippet additionally `?? process.env.X`-falls
 * back, which is harmless.
 */
export async function resolveProviderKey(
  provider: ProviderKeyName,
  opts?: ResolveProviderKeyOptions,
): Promise<string> {
  const pool = await listProviderKeyPool(provider, opts?.tier);
  return pool[0] ?? "";
}
