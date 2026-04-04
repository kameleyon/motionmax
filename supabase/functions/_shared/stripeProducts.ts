/**
 * Stripe product ID mappings — shared across all edge functions.
 *
 * Keep in sync with src/config/stripeProducts.ts (frontend).
 * The webhook and other edge functions import from here.
 */

// Credit pack product IDs → number of credits granted
export const creditPackProducts: Record<string, number> = {
  // Current packs
  "prod_Ts3r9EBXzzKKfU": 15,   // 15 credits - $11.99
  "prod_Tnz0B2aJPD895y": 50,   // 50 credits - $14.99
  "prod_Tnz1CygtJnMhUz": 150,  // 150 credits - $39.99
  "prod_Ts3rl1zDT9oLVt": 500,  // 500 credits - $249.99
  // Legacy packs (keep for existing purchases)
  "prod_TqznJ5NkfAEdUY": 15,
  "prod_TqznSfnDazIjj2": 50,
  "prod_Tqznn5NHeJnhS6": 150,
  "prod_Tqznoknz2TmraQ": 500,
  "prod_TnzLJDYSV45eEF": 10,   // 10 credits (legacy)
  "prod_TnzL0a9nwvoZKm": 50,   // 50 credits (legacy)
  "prod_TnzL2ewLWIt1hD": 150,  // 150 credits (legacy)
};

// Subscription product IDs → plan name
export const subscriptionProducts: Record<string, string> = {
  // Current plans
  "prod_Tnyz2nMLqpHz3R": "starter",
  "prod_Tnz0KUQX2J5VBH": "creator",
  "prod_Tnz0BeRmJDdh0V": "professional",
  // Legacy plans (keep for existing subscriptions)
  "prod_TqznNZmUhevHh4": "starter",
  "prod_TqznlgT1Jl6Re7": "creator",
  "prod_TqznqQYYG4UUY8": "professional",
  "prod_TnzLdHWPkqAiqr": "starter",
  "prod_TnzLCasreSakEb": "creator",
  "prod_TnzLP4tQINtak9": "professional",
};

// Monthly credit allocation per plan (granted on invoice.paid)
export const monthlyCredits: Record<string, number> = {
  starter: 30,
  creator: 100,
  professional: 300,
};
