/**
 * Stripe product / price ID configuration.
 *
 * All Stripe IDs centralised here. Each value can be overridden at
 * build-time via a `VITE_STRIPE_*` environment variable.
 */

const env = import.meta.env;

// ---------------------------------------------------------------------------
// Subscription plans
// ---------------------------------------------------------------------------

export const STRIPE_PLANS = {
  creator: {
    monthly: {
      priceId: env.VITE_STRIPE_CREATOR_MONTHLY ?? "price_1TJ1Z86hfVkBDzkS8irL0G15",
      productId: env.VITE_STRIPE_CREATOR_PRODUCT ?? "prod_UHakcDFbS7Vw7z",
    },
    yearly: {
      priceId: env.VITE_STRIPE_CREATOR_YEARLY ?? "price_1TJ1Z86hfVkBDzkSHW3ZsXm3",
      productId: env.VITE_STRIPE_CREATOR_PRODUCT ?? "prod_UHakcDFbS7Vw7z",
    },
  },
  // "professional" key kept for backward compat (maps to Studio)
  professional: {
    monthly: {
      priceId: env.VITE_STRIPE_STUDIO_MONTHLY ?? "price_1TJ1ZO6hfVkBDzkSfypYrf47",
      productId: env.VITE_STRIPE_STUDIO_PRODUCT ?? "prod_UHakOYLBpnWBj8",
    },
    yearly: {
      priceId: env.VITE_STRIPE_STUDIO_YEARLY ?? "price_1TJ1ZP6hfVkBDzkSQWTNjJ8o",
      productId: env.VITE_STRIPE_STUDIO_PRODUCT ?? "prod_UHakOYLBpnWBj8",
    },
  },
  // Alias
  get studio() { return this.professional; },
  // Legacy starter -> creator
  get starter() { return this.creator; },
} as const;

// ---------------------------------------------------------------------------
// Credit packs (one-time purchases)
// ---------------------------------------------------------------------------

export const CREDIT_PACKS = {
  300: {
    priceId: env.VITE_STRIPE_CREDITS_300 ?? "price_1TJ1Zl6hfVkBDzkS1lOlizEc",
    productId: env.VITE_STRIPE_CREDITS_300_PRODUCT ?? "prod_UHalTrTNeIhUNX",
    price: 9.99,
  },
  900: {
    priceId: env.VITE_STRIPE_CREDITS_900 ?? "price_1TJ1Zm6hfVkBDzkSUbYVMrR6",
    productId: env.VITE_STRIPE_CREDITS_900_PRODUCT ?? "prod_UHalEgw5TyQdFM",
    price: 24.99,
  },
  2500: {
    priceId: env.VITE_STRIPE_CREDITS_2500 ?? "price_1TJ1Zn6hfVkBDzkSpc8GTgIm",
    productId: env.VITE_STRIPE_CREDITS_2500_PRODUCT ?? "prod_UHalwIOINit7zr",
    price: 59.99,
  },
} as const;
