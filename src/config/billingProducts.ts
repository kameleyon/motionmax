/**
 * Billing & Plans — frontend SKU catalog.
 *
 * The Stripe price IDs come from environment variables, populated
 * after running `scripts/stripe-create-billing-products.ts`. Until
 * those are set we fall back to the legacy CREDIT_PACKS (300 / 900 /
 * 2500 cr) whose IDs ship in stripeProducts.ts.
 *
 * Vite env vars (read at build time):
 *   VITE_STRIPE_TOPUP_500_PRICE         price for 500 cr / $5
 *   VITE_STRIPE_TOPUP_2000_PRICE        price for 2000 cr / $19
 *   VITE_STRIPE_TOPUP_10000_PRICE       price for 10000 cr / $79
 *   VITE_STRIPE_TOPUP_50000_PRICE       price for 50000 cr / $349
 */

import { CREDIT_PACKS } from "@/config/stripeProducts";

const env = import.meta.env;

export interface TopupSku {
  credits: number;
  priceUsd: number;
  perCredit: number;
  /** Stripe Price ID (from the env vars above, or a fallback). */
  priceId: string;
  ribbon?: "popular" | "best-value";
  saveLabel?: string;
}

export const TOPUP_SKUS: TopupSku[] = [
  {
    credits: 500,
    priceUsd: 5,
    perCredit: 0.010,
    priceId: env.VITE_STRIPE_TOPUP_500_PRICE ?? CREDIT_PACKS[300].priceId,
  },
  {
    credits: 2000,
    priceUsd: 19,
    perCredit: 0.0095,
    priceId: env.VITE_STRIPE_TOPUP_2000_PRICE ?? CREDIT_PACKS[900].priceId,
    ribbon: "popular",
    saveLabel: "Save 5% vs 500-pack",
  },
  {
    credits: 10000,
    priceUsd: 79,
    perCredit: 0.0079,
    priceId: env.VITE_STRIPE_TOPUP_10000_PRICE ?? CREDIT_PACKS[2500].priceId,
    ribbon: "best-value",
    saveLabel: "Save 21% vs 500-pack",
  },
  {
    credits: 50000,
    priceUsd: 349,
    perCredit: 0.0070,
    priceId: env.VITE_STRIPE_TOPUP_50000_PRICE ?? CREDIT_PACKS[2500].priceId,
    saveLabel: "Save 30% vs 500-pack",
  },
];

/** Tiered pricing function used by the custom slider. Mirrors the
 *  rate ladder from the design's slider.js. */
export function tieredRate(credits: number): number {
  if (credits <= 500) return 0.010;
  if (credits <= 2000) return 0.0095;
  if (credits <= 10000) return 0.0079;
  if (credits <= 50000) return 0.0070;
  return 0.0065;
}

/** Find the closest existing SKU at-or-above the requested amount.
 *  Returned SKU is what we'll actually charge through Stripe. */
export function closestSkuFor(credits: number): TopupSku {
  const sortedAsc = [...TOPUP_SKUS].sort((a, b) => a.credits - b.credits);
  for (const s of sortedAsc) {
    if (s.credits >= credits) return s;
  }
  return sortedAsc[sortedAsc.length - 1];
}
