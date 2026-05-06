/**
 * stripe-create-billing-products.ts
 * ============================================================
 * One-shot Stripe product/price creation for the new MotionMax
 * Billing & Plans page (2026-05-06).
 *
 * USAGE:
 *   STRIPE_SECRET_KEY=sk_live_xxx npx tsx scripts/stripe-create-billing-products.ts
 *
 *   (use sk_test_xxx in dev — script reads STRIPE_SECRET_KEY only)
 *
 * WHAT IT CREATES (idempotent — checks `metadata.motionmax_sku` first):
 *
 *   ── 4 one-time top-up packs (mode: payment) ────────────
 *   topup_500    — 500 cr / $5
 *   topup_2000   — 2000 cr / $19
 *   topup_10000  — 10000 cr / $79
 *   topup_50000  — 50000 cr / $349
 *
 *   ── 4 pack add-on recurring prices (subscription items) ──
 *   pack_addon_creator_monthly  — $5/mo  per quantity unit
 *   pack_addon_creator_yearly   — $50/yr per quantity unit
 *   pack_addon_studio_monthly   — $20/mo per quantity unit
 *   pack_addon_studio_yearly    — $200/yr per quantity unit
 *
 *   ── 1 retention coupon ───────────────────────────────
 *   RETAIN50 — 50% off for 3 months (used by the Cancel modal)
 *
 * RATIONALE FOR PACK-ADDON PRICES:
 *   The base Creator monthly plan is $19 → 500 credits.
 *   The base Studio  monthly plan is $39 → 2,500 credits.
 *   We sell "pack add-ons" as Stripe SubscriptionItems with
 *   a quantity multiplier (1x default, 2x / 4x / 10x).
 *   Quantity=1 is included in the base — the add-on item is
 *   added at quantity=0 by default and increased via the
 *   update-pack-quantity edge fn. Each additional "pack" of
 *   the Creator add-on grants +500 credits/cycle for $5/mo.
 *   Each additional Studio pack grants +2,500 credits for $20/mo.
 *   Annual prices are 10x monthly (saves 17% — matches existing).
 *
 * IMPORTANT: This script does NOT delete or modify existing
 * Stripe objects. Re-running is safe; existing SKUs are skipped.
 * ============================================================
 */

import * as fs from "node:fs";
import * as path from "node:path";

const STRIPE_API = "https://api.stripe.com/v1";
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error("STRIPE_SECRET_KEY is required");
  process.exit(1);
}

// --- Stripe REST helpers (no SDK to keep this script dep-free) ---

function form(obj: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(form(value as Record<string, unknown>, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripe<T = unknown>(
  method: "GET" | "POST",
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${STRIPE_API}${endpoint}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (method === "POST" && body) init.body = form(body);
  if (method === "GET" && body) {
    const qs = form(body);
    return stripe(method, `${endpoint}?${qs}`);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe ${method} ${endpoint} ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

interface StripeListProducts {
  data: Array<{ id: string; metadata: Record<string, string> }>;
  has_more: boolean;
}

interface StripeProduct {
  id: string;
  metadata: Record<string, string>;
}

interface StripePrice {
  id: string;
  product: string;
}

interface StripeCoupon {
  id: string;
  metadata: Record<string, string>;
}

async function findProductBySku(sku: string): Promise<StripeProduct | null> {
  // Stripe's product list doesn't filter by metadata directly; we
  // page through and match. For an account with thousands of
  // products this would need search API; here we have a small set.
  let starting_after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list: StripeListProducts = await stripe("GET", "/products", {
      limit: 100,
      ...(starting_after ? { starting_after } : {}),
    });
    const hit = list.data.find((p) => p.metadata?.motionmax_sku === sku);
    if (hit) return hit as StripeProduct;
    if (!list.has_more) break;
    starting_after = list.data[list.data.length - 1]?.id;
  }
  return null;
}

async function findPriceForProduct(productId: string, lookupKey: string): Promise<StripePrice | null> {
  const list = await stripe<{ data: Array<StripePrice & { lookup_key: string | null; metadata?: Record<string, string> }> }>(
    "GET",
    "/prices",
    { product: productId, limit: 100, active: true },
  );
  return list.data.find((p) => p.lookup_key === lookupKey || p.metadata?.motionmax_sku === lookupKey) ?? null;
}

async function createProduct(sku: string, name: string, metadata: Record<string, string> = {}): Promise<StripeProduct> {
  return stripe("POST", "/products", {
    name,
    metadata: { ...metadata, motionmax_sku: sku },
  });
}

async function createPrice(opts: {
  product: string;
  unit_amount: number; // cents
  currency: string;
  recurring?: { interval: "month" | "year" };
  lookup_key: string;
  sku: string;
}): Promise<StripePrice> {
  const body: Record<string, unknown> = {
    product: opts.product,
    unit_amount: opts.unit_amount,
    currency: opts.currency,
    lookup_key: opts.lookup_key,
    metadata: { motionmax_sku: opts.sku },
    transfer_lookup_key: true,
  };
  if (opts.recurring) body.recurring = opts.recurring;
  return stripe("POST", "/prices", body);
}

async function ensureProductWithPrice(
  sku: string,
  name: string,
  amountCents: number,
  recurring?: { interval: "month" | "year" },
  productMetadata: Record<string, string> = {},
): Promise<{ productId: string; priceId: string; created: boolean }> {
  let product = await findProductBySku(sku);
  let created = false;
  if (!product) {
    product = await createProduct(sku, name, productMetadata);
    created = true;
    console.log(`  + created product ${sku} -> ${product.id}`);
  } else {
    console.log(`  = product ${sku} exists -> ${product.id}`);
  }

  let price = await findPriceForProduct(product.id, sku);
  if (!price) {
    price = await createPrice({
      product: product.id,
      unit_amount: amountCents,
      currency: "usd",
      recurring,
      lookup_key: sku,
      sku,
    });
    created = true;
    console.log(`  + created price  ${sku} -> ${price.id} ($${(amountCents / 100).toFixed(2)}${recurring ? "/" + recurring.interval : ""})`);
  } else {
    console.log(`  = price   ${sku} exists -> ${price.id}`);
  }

  return { productId: product.id, priceId: price.id, created };
}

async function ensureCoupon(id: string, name: string, percent_off: number, duration_in_months: number) {
  try {
    const existing = await stripe<StripeCoupon>("GET", `/coupons/${id}`);
    console.log(`  = coupon ${id} exists`);
    return existing;
  } catch (e) {
    void e;
  }
  const created = await stripe<StripeCoupon>("POST", "/coupons", {
    id,
    name,
    percent_off,
    duration: "repeating",
    duration_in_months,
    metadata: { motionmax_sku: id },
  });
  console.log(`  + created coupon ${id} (${percent_off}% off ${duration_in_months} mo)`);
  return created;
}

// --- Catalog --------------------------------------------------

interface SkuDef {
  sku: string;
  name: string;
  amountCents: number;
  recurring?: { interval: "month" | "year" };
  meta?: Record<string, string>;
}

const TOP_UP_SKUS: SkuDef[] = [
  { sku: "topup_500",   name: "MotionMax — 500 credits",    amountCents: 500,   meta: { credits: "500",   kind: "topup" } },
  { sku: "topup_2000",  name: "MotionMax — 2,000 credits",  amountCents: 1900,  meta: { credits: "2000",  kind: "topup" } },
  { sku: "topup_10000", name: "MotionMax — 10,000 credits", amountCents: 7900,  meta: { credits: "10000", kind: "topup" } },
  { sku: "topup_50000", name: "MotionMax — 50,000 credits", amountCents: 34900, meta: { credits: "50000", kind: "topup" } },
];

// Pack add-on prices. The unit_amount is per quantity unit. The
// base plan already includes 1 "pack" — extras are billed at this
// rate. Creator pack = +500 cr/$5/mo. Studio pack = +2500 cr/$20/mo.
const PACK_ADDON_SKUS: SkuDef[] = [
  { sku: "pack_addon_creator_monthly", name: "MotionMax — Creator pack add-on (monthly)", amountCents: 500,   recurring: { interval: "month" }, meta: { plan: "creator", kind: "pack_addon", grant_credits: "500" } },
  { sku: "pack_addon_creator_yearly",  name: "MotionMax — Creator pack add-on (yearly)",  amountCents: 5000,  recurring: { interval: "year" },  meta: { plan: "creator", kind: "pack_addon", grant_credits: "500" } },
  { sku: "pack_addon_studio_monthly",  name: "MotionMax — Studio pack add-on (monthly)",  amountCents: 2000,  recurring: { interval: "month" }, meta: { plan: "studio",  kind: "pack_addon", grant_credits: "2500" } },
  { sku: "pack_addon_studio_yearly",   name: "MotionMax — Studio pack add-on (yearly)",   amountCents: 20000, recurring: { interval: "year" },  meta: { plan: "studio",  kind: "pack_addon", grant_credits: "2500" } },
];

async function main() {
  const out: Record<string, { productId: string; priceId: string }> = {};

  console.log("\n--- Top-up packs (one-time, mode: payment) ---");
  for (const s of TOP_UP_SKUS) {
    const r = await ensureProductWithPrice(s.sku, s.name, s.amountCents, undefined, s.meta);
    out[s.sku] = { productId: r.productId, priceId: r.priceId };
  }

  console.log("\n--- Pack add-on recurring prices ---");
  for (const s of PACK_ADDON_SKUS) {
    const r = await ensureProductWithPrice(s.sku, s.name, s.amountCents, s.recurring, s.meta);
    out[s.sku] = { productId: r.productId, priceId: r.priceId };
  }

  console.log("\n--- Retention coupon ---");
  await ensureCoupon("RETAIN50", "MotionMax retention 50% off 3 months", 50, 3);

  // Persist generated map
  const target = path.resolve("supabase/functions/_shared/stripeProductsGenerated.ts");
  const ts = `// AUTO-GENERATED by scripts/stripe-create-billing-products.ts
// Do not edit by hand. Re-run the script to regenerate.

export const GENERATED_BILLING_SKUS = ${JSON.stringify(out, null, 2)} as const;

export type GeneratedSku = keyof typeof GENERATED_BILLING_SKUS;
`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ts, "utf8");
  console.log(`\nWrote ${target}`);

  console.log("\n=== JSON output ===");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
