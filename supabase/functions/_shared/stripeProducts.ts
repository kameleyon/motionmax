/**
 * Stripe product ID mappings -- shared across all edge functions.
 *
 * Keep in sync with src/config/stripeProducts.ts (frontend).
 *
 * NOTE: When you create new Stripe products for the Creator ($29) and
 * Studio ($99) plans, add their product IDs here and map them to
 * "creator" and "studio" respectively.
 */

// Credit pack product IDs -> number of credits granted
export const creditPackProducts: Record<string, number> = {
  // New packs (create in Stripe: $9.99/300, $24.99/900, $59.99/2500)
  // "prod_NEW_300":  300,
  // "prod_NEW_900":  900,
  // "prod_NEW_2500": 2500,
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
// Map old plan names to new: starter -> creator, professional -> studio
export const subscriptionProducts: Record<string, string> = {
  // Current plans (remap to new names)
  "prod_Tnyz2nMLqpHz3R": "creator",       // was starter
  "prod_Tnz0KUQX2J5VBH": "creator",       // was creator
  "prod_Tnz0BeRmJDdh0V": "studio",        // was professional
  // Legacy plans
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
  // Legacy mappings (in case old plan names still exist in DB)
  starter: 500,
  professional: 2500,
};
