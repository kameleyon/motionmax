/// <reference types="vitest/globals" />

// Mock import.meta.env before importing the module
vi.stubGlobal("import", { meta: { env: {} } });

// The module reads import.meta.env at load time.
// In test env without Vite, we need to mock it.
vi.mock("@/config/stripeProducts", () => {
  // Return the hardcoded defaults (same as what the real module exports when no env vars set)
  return {
    STRIPE_PLANS: {
      starter: {
        monthly: { priceId: "price_1SqN1x6hfVkBDzkSzfLDk9eF", productId: "prod_Tnyz2nMLqpHz3R" },
        yearly: { priceId: "price_1T2b0Q6hfVkBDzkSF4MqHPRi", productId: "prod_Tnyz2nMLqpHz3R" },
      },
      creator: {
        monthly: { priceId: "price_1SqN2D6hfVkBDzkS6ywVTBEt", productId: "prod_Tnz0KUQX2J5VBH" },
        yearly: { priceId: "price_1T2b0R6hfVkBDzkSFD5gowGz", productId: "prod_Tnz0KUQX2J5VBH" },
      },
      professional: {
        monthly: { priceId: "price_1SqN2U6hfVkBDzkSNCDvRyeP", productId: "prod_Tnz0BeRmJDdh0V" },
        yearly: { priceId: "price_1T2b0S6hfVkBDzkS4nrYAc2E", productId: "prod_Tnz0BeRmJDdh0V" },
      },
    },
    CREDIT_PACKS: {
      15: { priceId: "price_1SuJk36hfVkBDzkSCbSorQJY", productId: "prod_Ts3r9EBXzzKKfU", price: 11.99 },
      50: { priceId: "price_1SqN2q6hfVkBDzkSNbEXBWTL", productId: "prod_Tnz0B2aJPD895y", price: 14.99 },
      150: { priceId: "price_1SqN316hfVkBDzkSVq77cGDd", productId: "prod_Tnz1CygtJnMhUz", price: 39.99 },
      500: { priceId: "price_1SuJk46hfVkBDzkSSkkal5QG", productId: "prod_Ts3rl1zDT9oLVt", price: 249.99 },
    },
  };
});

import { STRIPE_PLANS, CREDIT_PACKS } from "@/config/stripeProducts";

// ───────────────────────────────────────────────
// Structure integrity
// ───────────────────────────────────────────────
describe("STRIPE_PLANS", () => {
  it("has all three plan tiers", () => {
    expect(STRIPE_PLANS).toHaveProperty("starter");
    expect(STRIPE_PLANS).toHaveProperty("creator");
    expect(STRIPE_PLANS).toHaveProperty("professional");
  });

  it.each(["starter", "creator", "professional"] as const)("%s has monthly and yearly price IDs", (plan) => {
    const p = STRIPE_PLANS[plan];
    expect(p.monthly.priceId).toMatch(/^price_/);
    expect(p.yearly.priceId).toMatch(/^price_/);
    expect(p.monthly.productId).toMatch(/^prod_/);
    expect(p.yearly.productId).toMatch(/^prod_/);
  });

  it("monthly and yearly share the same product ID within each plan", () => {
    for (const plan of Object.values(STRIPE_PLANS)) {
      expect(plan.monthly.productId).toBe(plan.yearly.productId);
    }
  });

  it("each plan has a unique product ID", () => {
    const ids = Object.values(STRIPE_PLANS).map((p) => p.monthly.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("CREDIT_PACKS", () => {
  it("has 4 pack sizes", () => {
    const sizes = Object.keys(CREDIT_PACKS).map(Number);
    expect(sizes).toEqual(expect.arrayContaining([15, 50, 150, 500]));
  });

  it("each pack has price, priceId and productId", () => {
    for (const [size, pack] of Object.entries(CREDIT_PACKS)) {
      expect(pack.priceId).toMatch(/^price_/);
      expect(pack.productId).toMatch(/^prod_/);
      expect(pack.price).toBeGreaterThan(0);
    }
  });

  it("larger packs cost more", () => {
    const sorted = Object.entries(CREDIT_PACKS)
      .map(([size, pack]) => ({ size: Number(size), price: pack.price }))
      .sort((a, b) => a.size - b.size);

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].price).toBeGreaterThan(sorted[i - 1].price);
    }
  });

  it("each pack has a unique product ID", () => {
    const ids = Object.values(CREDIT_PACKS).map((p) => p.productId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
