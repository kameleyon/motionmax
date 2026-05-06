/**
 * Stripe product ID mappings -- shared across all edge functions.
 * Keep in sync with src/config/stripeProducts.ts (frontend).
 */

// Credit pack product IDs -> number of credits granted
export const creditPackProducts: Record<string, number> = {
  // New packs
  "prod_UHalTrTNeIhUNX": 300,   // 300 credits - $9.99
  "prod_UHalEgw5TyQdFM": 900,   // 900 credits - $24.99
  "prod_UHalwIOINit7zr": 2500,  // 2500 credits - $59.99
  // Legacy packs (keep for existing purchases)
  "prod_Ts3r9EBXzzKKfU": 15,
  "prod_Tnz0B2aJPD895y": 50,
  "prod_Tnz1CygtJnMhUz": 150,
  "prod_Ts3rl1zDT9oLVt": 500,
  "prod_TqznJ5NkfAEdUY": 15,
  "prod_TqznSfnDazIjj2": 50,
  "prod_Tqznn5NHeJnhS6": 150,
  "prod_Tqznoknz2TmraQ": 500,
  "prod_TnzLJDYSV45eEF": 10,
  "prod_TnzL0a9nwvoZKm": 50,
  "prod_TnzL2ewLWIt1hD": 150,
};

// Subscription product IDs -> plan name
export const subscriptionProducts: Record<string, string> = {
  // New plans
  "prod_UHakcDFbS7Vw7z": "creator",
  "prod_UHakOYLBpnWBj8": "studio",
  // Legacy plans (map to new names)
  "prod_Tnyz2nMLqpHz3R": "creator",
  "prod_Tnz0KUQX2J5VBH": "creator",
  "prod_Tnz0BeRmJDdh0V": "studio",
  "prod_TqznNZmUhevHh4": "creator",
  "prod_TqznlgT1Jl6Re7": "creator",
  "prod_TqznqQYYG4UUY8": "studio",
  "prod_TnzLdHWPkqAiqr": "creator",
  "prod_TnzLCasreSakEb": "creator",
  "prod_TnzLP4tQINtak9": "studio",
};

// Monthly credit allocation per plan (granted on invoice.paid)
export const monthlyCredits: Record<string, number> = {
  creator: 500,
  studio: 2500,
  // Legacy fallbacks
  starter: 500,
  professional: 2500,
};

// ============================================================
// 2026-05-06 Billing & Plans rebuild — new SKU catalog.
// ------------------------------------------------------------
// These maps are looked up alongside the legacy ones in the
// webhook (creditPackProducts) and create-checkout (VALID_PRODUCT_IDS).
// Real product/price IDs are written by scripts/stripe-create-billing-products.ts
// into stripeProductsGenerated.ts; until that runs in production the
// SKU label is enough for the webhook to route.
// ============================================================

/** New top-up SKUs created 2026-05-06. SKU -> credits granted. */
export const newTopupSkuToCredits: Record<string, number> = {
  topup_500: 500,
  topup_2000: 2000,
  topup_10000: 10000,
  topup_50000: 50000,
};

/** New pack add-on SKUs (recurring). SKU -> credits granted PER quantity unit. */
export const packAddonSkuToCredits: Record<string, { plan: "creator" | "studio"; perUnit: number }> = {
  pack_addon_creator_monthly: { plan: "creator", perUnit: 500 },
  pack_addon_creator_yearly:  { plan: "creator", perUnit: 500 },
  pack_addon_studio_monthly:  { plan: "studio",  perUnit: 2500 },
  pack_addon_studio_yearly:   { plan: "studio",  perUnit: 2500 },
};
