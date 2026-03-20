/**
 * Stripe product / price ID configuration.
 *
 * All Stripe IDs are centralised here.  Each value can be overridden at
 * build-time via a `VITE_STRIPE_*` environment variable so that pricing
 * changes no longer require code deployments.
 *
 * The `create-checkout` edge function validates every price ID against the
 * Stripe API at runtime — if an override contains a typo, checkout will
 * reject it before any charge is made.
 */

const env = import.meta.env;

// ---------------------------------------------------------------------------
// Subscription plans
// ---------------------------------------------------------------------------

export const STRIPE_PLANS = {
  starter: {
    monthly: {
      priceId: env.VITE_STRIPE_STARTER_MONTHLY  ?? "price_1SqN1x6hfVkBDzkSzfLDk9eF",
      productId: env.VITE_STRIPE_STARTER_PRODUCT ?? "prod_Tnyz2nMLqpHz3R",
    },
    yearly: {
      priceId: env.VITE_STRIPE_STARTER_YEARLY    ?? "price_1T2b0Q6hfVkBDzkSF4MqHPRi",
      productId: env.VITE_STRIPE_STARTER_PRODUCT ?? "prod_Tnyz2nMLqpHz3R",
    },
  },
  creator: {
    monthly: {
      priceId: env.VITE_STRIPE_CREATOR_MONTHLY  ?? "price_1SqN2D6hfVkBDzkS6ywVTBEt",
      productId: env.VITE_STRIPE_CREATOR_PRODUCT ?? "prod_Tnz0KUQX2J5VBH",
    },
    yearly: {
      priceId: env.VITE_STRIPE_CREATOR_YEARLY    ?? "price_1T2b0R6hfVkBDzkSFD5gowGz",
      productId: env.VITE_STRIPE_CREATOR_PRODUCT ?? "prod_Tnz0KUQX2J5VBH",
    },
  },
  professional: {
    monthly: {
      priceId: env.VITE_STRIPE_PRO_MONTHLY  ?? "price_1SqN2U6hfVkBDzkSNCDvRyeP",
      productId: env.VITE_STRIPE_PRO_PRODUCT ?? "prod_Tnz0BeRmJDdh0V",
    },
    yearly: {
      priceId: env.VITE_STRIPE_PRO_YEARLY    ?? "price_1T2b0S6hfVkBDzkS4nrYAc2E",
      productId: env.VITE_STRIPE_PRO_PRODUCT ?? "prod_Tnz0BeRmJDdh0V",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Credit packs  (one-time purchases)
// ---------------------------------------------------------------------------

export const CREDIT_PACKS = {
  15: {
    priceId: env.VITE_STRIPE_CREDITS_15   ?? "price_1SuJk36hfVkBDzkSCbSorQJY",
    productId: env.VITE_STRIPE_CREDITS_15_PRODUCT ?? "prod_Ts3r9EBXzzKKfU",
    price: 11.99,
  },
  50: {
    priceId: env.VITE_STRIPE_CREDITS_50   ?? "price_1SqN2q6hfVkBDzkSNbEXBWTL",
    productId: env.VITE_STRIPE_CREDITS_50_PRODUCT ?? "prod_Tnz0B2aJPD895y",
    price: 14.99,
  },
  150: {
    priceId: env.VITE_STRIPE_CREDITS_150  ?? "price_1SqN316hfVkBDzkSVq77cGDd",
    productId: env.VITE_STRIPE_CREDITS_150_PRODUCT ?? "prod_Tnz1CygtJnMhUz",
    price: 39.99,
  },
  500: {
    priceId: env.VITE_STRIPE_CREDITS_500  ?? "price_1SuJk46hfVkBDzkSSkkal5QG",
    productId: env.VITE_STRIPE_CREDITS_500_PRODUCT ?? "prod_Ts3rl1zDT9oLVt",
    price: 249.99,
  },
} as const;
