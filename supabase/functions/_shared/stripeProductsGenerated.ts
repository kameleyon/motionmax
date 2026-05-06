// AUTO-GENERATED placeholder for scripts/stripe-create-billing-products.ts
//
// Run the script (see header in scripts/stripe-create-billing-products.ts)
// to overwrite this file with real Stripe product/price IDs:
//
//   STRIPE_SECRET_KEY=sk_... npx tsx scripts/stripe-create-billing-products.ts
//
// Until then, this empty map keeps the build green and lets the edge
// functions fall back to the legacy CREDIT_PACKS/STRIPE_PLANS catalog.

export const GENERATED_BILLING_SKUS: Record<
  string,
  { productId: string; priceId: string }
> = {} as const;

export type GeneratedSku = keyof typeof GENERATED_BILLING_SKUS;
