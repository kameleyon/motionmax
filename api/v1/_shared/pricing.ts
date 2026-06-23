// MotionMax Public API — pricing layer (api/v1).
//
// Implements roadmap §4(a) recommendation 1: "Price to the worst case, treat
// cheap rungs as upside." The public per-request price is pinned to the most
// expensive rung in the provider cascade so margin stays positive even when a
// job falls through to a premium fallback path. We NEVER quote the cheap rung.
//
// The quoted figure is a STABLE, quotable credit price (no dynamic per-call
// pricing in v1 — see the autopost incident in planLimits.ts history where a
// UI quoted 45 credits while SQL charged 75–1800). The credit number is kept
// at/above getCreditsRequired()'s scale so we never undercut the existing
// consumer credit economy.

import type { VideoMode, VideoLength, PriceQuote } from "./contract";
import { worstRungVideoCostUsd } from "../../../worker/src/lib/providerRates";

// ─────────────────────────────────────────────────────────────────────────────
// Credit → USD assumptions (top-of-file constants, per assignment).
//
// CREDIT_USD_RATE: the dollar value of one MotionMax credit. The consumer
//   economy treats 1 credit ≈ 1 second of standard video output (planLimits.ts).
//   At the current published price (~$15 / 500 creator credits) a credit is
//   worth ~$0.03 retail. We anchor the API's credit→USD reconciliation rate to
//   that retail value so the refund layer and margin metrics speak the same
//   units as the storefront.
// MARGIN_MULTIPLIER: gross-margin target applied to the worst-rung provider
//   cost before converting to credits. 3× keeps positive margin even when the
//   whole cascade degrades to the premium rung (roadmap §4(a)).
// FLOOR_CREDITS: absolute minimum credits per request, independent of cost, so
//   tiny requests still cover fixed LLM/image/orchestration overhead that the
//   video-only worst-rung figure does not capture.
// ─────────────────────────────────────────────────────────────────────────────

/** USD value of one MotionMax credit (retail anchor). */
export const CREDIT_USD_RATE = 0.03;

/** Gross-margin target applied to worst-rung provider cost. */
export const MARGIN_MULTIPLIER = 3;

/** Absolute minimum credits per public API request. */
export const FLOOR_CREDITS = 75;

// Expected worst-case clip count per requested length. worstRungVideoCostUsd()
// returns the USD for a single worst-case 10s clip; a full generation emits
// many clips, so we scale by the clip count implied by each length. These
// counts mirror LENGTH_SECONDS / 10 from planLimits.ts (short:150 → 15,
// brief:280 → 28, presentation:360 → 36) so the quoted price tracks the same
// scale as getCreditsRequired() rather than under-quoting a long job.
const CLIPS_PER_LENGTH: Record<VideoLength, number> = {
  short: 15,
  brief: 28,
  presentation: 36,
};

const DEFAULT_LENGTH: VideoLength = "short";

/**
 * Price a public /api/v1 video request to the worst rung in its cascade.
 *
 * price (credits) = max(
 *   FLOOR_CREDITS,
 *   ceil( worst_rung_usd_total × MARGIN_MULTIPLIER / CREDIT_USD_RATE )
 * )
 *
 * where worst_rung_usd_total = (worst-case single-clip USD) × (clips for length).
 *
 * @param mode    generation product (doc2video | smartflow | cinematic)
 * @param length  requested length; defaults to "short" when omitted
 * @param format  aspect ratio (forwarded to the rate card; no rung change today)
 */
export function priceRequest(
  mode: VideoMode,
  length: VideoLength | undefined,
  format?: string,
): PriceQuote {
  const resolvedLength: VideoLength = length ?? DEFAULT_LENGTH;
  const clips = CLIPS_PER_LENGTH[resolvedLength] ?? CLIPS_PER_LENGTH[DEFAULT_LENGTH];

  // Worst-case provider USD for the whole generation: the priciest single
  // clip rung times the expected clip count for this length.
  const worstClipUsd = worstRungVideoCostUsd(mode, format);
  const worstRungUsd = worstClipUsd * clips;

  // Convert worst-case USD (with margin) into credits, then floor-clamp.
  const costCredits = Math.ceil((worstRungUsd * MARGIN_MULTIPLIER) / CREDIT_USD_RATE);
  const credits = Math.max(FLOOR_CREDITS, costCredits);

  return {
    credits,
    worst_rung_usd: worstRungUsd,
    margin_multiplier: MARGIN_MULTIPLIER,
  };
}
