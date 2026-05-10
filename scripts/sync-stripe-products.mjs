#!/usr/bin/env node
/**
 * sync-stripe-products.mjs
 * ─────────────────────────────────────────────────────────────────────
 * One-shot, idempotent Stripe catalog provisioning for B-NEW-21 (the
 * Agent Opus pricing mirror with motionmax's Creator + Studio tiers).
 *
 * USAGE:
 *
 *   # 1) Drop a STRIPE_RESTRICTED_KEY into .env.local. Generate one at
 *   #    https://dashboard.stripe.com/apikeys (Restricted keys → "+ New
 *   #    restricted key"). Required permissions:
 *   #      Products       — Write
 *   #      Prices         — Write
 *   #      Coupons        — Write
 *   #      Promotion codes — Write (optional)
 *   #    Use the TEST-mode key first; re-run with --mode=live for prod.
 *   #
 *   # 2) Dry run to see what would be created (no Stripe API calls):
 *   #    node scripts/sync-stripe-products.mjs --dry-run
 *   #
 *   # 3) Real run, test mode (default):
 *   #    node scripts/sync-stripe-products.mjs
 *   #
 *   # 4) Real run, live mode:
 *   #    node scripts/sync-stripe-products.mjs --mode=live
 *   #
 *   # 5) Skip multi-pack add-on SKUs (handle them as Stripe quantity
 *   #    multipliers in checkout instead — recommended; the sync
 *   #    script's default skips them):
 *   #    node scripts/sync-stripe-products.mjs --skip-multipacks  # default ON
 *   #
 *   # 6) Or emit them as discrete SKUs (one product per multiplier
 *   #    per cycle per tier — 24 extra products total — for finance
 *   #    teams who want one-line-item-per-pack reporting):
 *   #    node scripts/sync-stripe-products.mjs --no-skip-multipacks
 *
 * WHAT IT CREATES (idempotent — checks Stripe by metadata.motionmax_sku
 * before creating; skips if exists, NEVER deletes anything):
 *
 *   PRODUCTS + RECURRING PRICES
 *   ───────────────────────────
 *   Creator                 prod  motionmax_creator
 *     ├── price  $29/mo      sku  creator_monthly       (with promo coupon)
 *     └── price  $174/yr     sku  creator_yearly        (one-time invoice)
 *
 *   Studio                  prod  motionmax_studio
 *     ├── price  $129/mo     sku  studio_monthly        (with promo coupon)
 *     └── price  $774/yr     sku  studio_yearly         (one-time invoice)
 *
 *   COUPONS (3-month repeating)
 *   ───────────────────────────
 *   creator_promo_3mo       ~34% off Creator monthly for 3 months
 *   studio_promo_3mo        ~30% off Studio  monthly for 3 months
 *
 *   TOP-UP PRODUCTS + ONE-TIME PRICES
 *   ─────────────────────────────────
 *   Quick Pack    250 cr  $14.99
 *   Plus Pack     500 cr  $24.99
 *   Power Pack  1,000 cr  $44.99
 *   Studio Pack 2,500 cr  $99.99
 *   Pro Pack    5,000 cr  $179.99
 *
 * AT END: prints a copy-pasteable env-var block. Paste into:
 *   • .env.local (and the matching VITE_STRIPE_PRICE_* mirrors so the
 *     React/Astro bundle picks them up at build time — see pricing.ts)
 *   • Vercel project env vars (Production + Preview + Development)
 *
 * SAFETY:
 *   • Idempotent: re-running is a no-op if nothing has changed.
 *   • NEVER deletes existing products, prices, or coupons. The
 *     B-NEW-21 reprice migration plan is for Jo to deactivate the OLD
 *     prices in the Stripe dashboard ONCE existing subscribers have
 *     been migrated — this script touches none of them.
 *   • Restricted-key only: do NOT pass a `sk_live_` secret-key. Use
 *     `rk_live_…` / `rk_test_…` so a leak can't drain your account.
 * ─────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── arg + env loading ──────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split("=")[1] : undefined;
};

const DRY_RUN = flag("--dry-run");
const SKIP_MULTIPACKS = !flag("--no-skip-multipacks"); // default: skip
const MODE = (opt("--mode") ?? process.env.STRIPE_MODE ?? "test").toLowerCase();
if (MODE !== "test" && MODE !== "live") {
  console.error(`FATAL: --mode must be 'test' or 'live' (got '${MODE}')`);
  process.exit(2);
}
const SUFFIX = MODE === "live" ? "LIVE" : "TEST";

// Lightweight .env.local parser — no dependency on dotenv for portability.
function loadDotEnvLocal() {
  const dotenvPath = path.resolve(".env.local");
  if (!fs.existsSync(dotenvPath)) return;
  const txt = fs.readFileSync(dotenvPath, "utf8");
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnvLocal();

const STRIPE_KEY =
  process.env.STRIPE_RESTRICTED_KEY ??
  process.env.STRIPE_SECRET_KEY; // accept secret-key in dev, but warn

if (!STRIPE_KEY) {
  console.error(
    "FATAL: STRIPE_RESTRICTED_KEY (or STRIPE_SECRET_KEY) must be set in .env.local or env.\n" +
      "       Generate a restricted key with Products+Prices+Coupons WRITE perms at:\n" +
      "       https://dashboard.stripe.com/apikeys",
  );
  process.exit(1);
}
if (!DRY_RUN && STRIPE_KEY.startsWith("sk_") && !STRIPE_KEY.startsWith("sk_test_")) {
  console.warn(
    "WARN: you're using a SECRET key (sk_live_…). Prefer a RESTRICTED key (rk_live_…) so a leak can't drain your account.",
  );
}

// ── Stripe REST helpers (no SDK to keep this script dep-free) ──────

const STRIPE_API = "https://api.stripe.com/v1";

function form(obj, prefix = "") {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "object" && v !== null) {
          parts.push(form(v, `${k}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(String(v))}`);
        }
      });
    } else if (typeof value === "object") {
      parts.push(form(value, k));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripe(method, endpoint, body) {
  if (DRY_RUN && method !== "GET") {
    console.log(`  [dry-run] ${method} ${endpoint} ${body ? JSON.stringify(body) : ""}`);
    // Synthesize a plausible-shape response so downstream code keeps going.
    if (endpoint === "/products") return { id: `prod_DRYRUN_${Date.now()}`, metadata: body?.metadata ?? {} };
    if (endpoint === "/prices") return { id: `price_DRYRUN_${Date.now()}`, product: body?.product };
    if (endpoint === "/coupons") return { id: body?.id ?? `coupon_DRYRUN_${Date.now()}`, metadata: body?.metadata ?? {} };
    return {};
  }
  const url = `${STRIPE_API}${endpoint}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
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
  return res.json();
}

async function findProductBySku(sku) {
  if (DRY_RUN) return null; // Skip the API call — pretend nothing exists.
  // Stripe's product list doesn't filter by metadata directly — page
  // through and match. For an account with thousands of products this
  // would need the search API; here we have <40 products tops.
  let starting_after;
  for (let page = 0; page < 20; page++) {
    const list = await stripe("GET", "/products", {
      limit: 100,
      ...(starting_after ? { starting_after } : {}),
    });
    const hit = list.data?.find((p) => p.metadata?.motionmax_sku === sku);
    if (hit) return hit;
    if (!list.has_more) break;
    starting_after = list.data?.[list.data.length - 1]?.id;
  }
  return null;
}

async function findPriceForProduct(productId, sku) {
  if (DRY_RUN) return null;
  const list = await stripe("GET", "/prices", {
    product: productId,
    limit: 100,
    active: true,
  });
  return (
    list.data?.find(
      (p) => p.lookup_key === sku || p.metadata?.motionmax_sku === sku,
    ) ?? null
  );
}

async function findCoupon(id) {
  if (DRY_RUN) return null;
  try {
    return await stripe("GET", `/coupons/${id}`);
  } catch {
    return null;
  }
}

async function ensureProduct(sku, name, description, metadata = {}) {
  let product = await findProductBySku(sku);
  if (product) {
    console.log(`  = product   ${sku.padEnd(28)} -> ${product.id}`);
    return product;
  }
  product = await stripe("POST", "/products", {
    name,
    description,
    metadata: { ...metadata, motionmax_sku: sku },
  });
  console.log(`  + product   ${sku.padEnd(28)} -> ${product.id}`);
  return product;
}

async function ensurePrice({ product, sku, amountCents, recurring }) {
  let price = await findPriceForProduct(product.id, sku);
  if (price) {
    console.log(`  = price     ${sku.padEnd(28)} -> ${price.id}`);
    return price;
  }
  const body = {
    product: product.id,
    unit_amount: amountCents,
    currency: "usd",
    lookup_key: sku,
    transfer_lookup_key: true,
    metadata: { motionmax_sku: sku },
  };
  if (recurring) body.recurring = recurring;
  price = await stripe("POST", "/prices", body);
  const tag = recurring ? `/${recurring.interval}` : " one-time";
  console.log(`  + price     ${sku.padEnd(28)} -> ${price.id}  ($${(amountCents / 100).toFixed(2)}${tag})`);
  return price;
}

async function ensureCoupon({ id, name, percent_off, duration_in_months }) {
  const existing = await findCoupon(id);
  if (existing) {
    console.log(`  = coupon    ${id.padEnd(28)} -> ${existing.id}`);
    return existing;
  }
  const created = await stripe("POST", "/coupons", {
    id,
    name,
    percent_off,
    duration: "repeating",
    duration_in_months,
    metadata: { motionmax_sku: id },
  });
  console.log(`  + coupon    ${id.padEnd(28)} -> ${created.id}  (${percent_off}% off ${duration_in_months}mo repeating)`);
  return created;
}

// ── Catalog (mirrors src/config/pricing.ts) ────────────────────────

const CREATOR = {
  sku: "motionmax_creator",
  name: "MotionMax — Creator",
  description: "For content creators and social media. 500 credits/month base allotment.",
  monthly: { sku: "creator_monthly", amountCents: 2900 }, // $29/mo
  yearly:  { sku: "creator_yearly",  amountCents: 17400 }, // $174/yr
  promo:   { id: "creator_promo_3mo", name: "Creator — 34% off first 3 months", percent_off: 34, duration_in_months: 3 },
};

const STUDIO = {
  sku: "motionmax_studio",
  name: "MotionMax — Studio",
  description: "For agencies and professional teams. 2,000 credits/month base allotment + priority queue.",
  monthly: { sku: "studio_monthly", amountCents: 12900 }, // $129/mo
  yearly:  { sku: "studio_yearly",  amountCents: 77400 }, // $774/yr
  promo:   { id: "studio_promo_3mo", name: "Studio — 30% off first 3 months", percent_off: 30, duration_in_months: 3 },
};

const TOP_UPS = [
  { sku: "topup_quick",  name: "MotionMax — Quick Pack (250 credits)",   credits: 250,   amountCents: 1499  },
  { sku: "topup_plus",   name: "MotionMax — Plus Pack (500 credits)",    credits: 500,   amountCents: 2499  },
  { sku: "topup_power",  name: "MotionMax — Power Pack (1,000 credits)", credits: 1000,  amountCents: 4499  },
  { sku: "topup_studio", name: "MotionMax — Studio Pack (2,500 credits)",credits: 2500,  amountCents: 9999  },
  { sku: "topup_pro",    name: "MotionMax — Pro Pack (5,000 credits)",   credits: 5000,  amountCents: 17999 },
];

// Optional discrete multi-pack add-on SKUs (one product per multiplier
// per cycle per tier). Off by default — Stripe `quantity` on the
// SubscriptionItem handles 1×–6× without extra SKUs.
function buildMultipackCatalog() {
  const out = [];
  const cycles = [
    { cycle: "monthly", interval: "month", base: { creator: 2900, studio: 12900 } },
    { cycle: "yearly",  interval: "year",  base: { creator: 17400, studio: 77400 } },
  ];
  for (const tier of ["creator", "studio"]) {
    for (const c of cycles) {
      for (let m = 2; m <= 6; m++) {
        out.push({
          sku: `${tier}_${c.cycle}_${m}x`,
          name: `MotionMax — ${tier === "creator" ? "Creator" : "Studio"} ${m}× pack (${c.cycle})`,
          amountCents: c.base[tier] * m,
          recurring: { interval: c.interval },
          parentSku: tier === "creator" ? CREATOR.sku : STUDIO.sku,
        });
      }
    }
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("\n=========================================================");
  console.log(`  motionmax Stripe sync  (mode=${MODE}${DRY_RUN ? ", DRY RUN" : ""})`);
  console.log(`  Catalog: B-NEW-21 (Agent Opus mirror, Creator/Studio names)`);
  console.log("=========================================================\n");

  const generated = {
    [`STRIPE_PRICE_CREATOR_MONTHLY_${SUFFIX}`]: null,
    [`STRIPE_PRICE_CREATOR_YEARLY_${SUFFIX}`]: null,
    [`STRIPE_PRICE_STUDIO_MONTHLY_${SUFFIX}`]: null,
    [`STRIPE_PRICE_STUDIO_YEARLY_${SUFFIX}`]: null,
    [`STRIPE_COUPON_CREATOR_PROMO_${SUFFIX}`]: null,
    [`STRIPE_COUPON_STUDIO_PROMO_${SUFFIX}`]: null,
    [`STRIPE_PRICE_TOPUP_QUICK_${SUFFIX}`]: null,
    [`STRIPE_PRICE_TOPUP_PLUS_${SUFFIX}`]: null,
    [`STRIPE_PRICE_TOPUP_POWER_${SUFFIX}`]: null,
    [`STRIPE_PRICE_TOPUP_STUDIO_${SUFFIX}`]: null,
    [`STRIPE_PRICE_TOPUP_PRO_${SUFFIX}`]: null,
  };

  // Subscriptions ────────────────────────────────────────────────
  console.log("--- Subscriptions ---");
  const creatorProd = await ensureProduct(CREATOR.sku, CREATOR.name, CREATOR.description, { tier: "creator" });
  const creatorMonthly = await ensurePrice({
    product: creatorProd, sku: CREATOR.monthly.sku,
    amountCents: CREATOR.monthly.amountCents, recurring: { interval: "month" },
  });
  const creatorYearly = await ensurePrice({
    product: creatorProd, sku: CREATOR.yearly.sku,
    amountCents: CREATOR.yearly.amountCents, recurring: { interval: "year" },
  });
  generated[`STRIPE_PRICE_CREATOR_MONTHLY_${SUFFIX}`] = creatorMonthly.id;
  generated[`STRIPE_PRICE_CREATOR_YEARLY_${SUFFIX}`] = creatorYearly.id;

  const studioProd = await ensureProduct(STUDIO.sku, STUDIO.name, STUDIO.description, { tier: "studio" });
  const studioMonthly = await ensurePrice({
    product: studioProd, sku: STUDIO.monthly.sku,
    amountCents: STUDIO.monthly.amountCents, recurring: { interval: "month" },
  });
  const studioYearly = await ensurePrice({
    product: studioProd, sku: STUDIO.yearly.sku,
    amountCents: STUDIO.yearly.amountCents, recurring: { interval: "year" },
  });
  generated[`STRIPE_PRICE_STUDIO_MONTHLY_${SUFFIX}`] = studioMonthly.id;
  generated[`STRIPE_PRICE_STUDIO_YEARLY_${SUFFIX}`] = studioYearly.id;

  // Coupons ──────────────────────────────────────────────────────
  console.log("\n--- Promo coupons (3-month repeating) ---");
  const creatorCoupon = await ensureCoupon(CREATOR.promo);
  const studioCoupon  = await ensureCoupon(STUDIO.promo);
  generated[`STRIPE_COUPON_CREATOR_PROMO_${SUFFIX}`] = creatorCoupon.id;
  generated[`STRIPE_COUPON_STUDIO_PROMO_${SUFFIX}`] = studioCoupon.id;

  // Top-ups ──────────────────────────────────────────────────────
  console.log("\n--- Top-up packs (one-time, mode: payment) ---");
  for (const t of TOP_UPS) {
    const prod = await ensureProduct(t.sku, t.name, `${t.credits.toLocaleString()} non-expiring credits.`, {
      kind: "topup",
      credits: String(t.credits),
    });
    const price = await ensurePrice({
      product: prod, sku: t.sku, amountCents: t.amountCents,
    });
    const skuName = t.sku.replace("topup_", "").toUpperCase();
    generated[`STRIPE_PRICE_TOPUP_${skuName}_${SUFFIX}`] = price.id;
  }

  // Optional multi-pack add-on SKUs ─────────────────────────────
  if (!SKIP_MULTIPACKS) {
    console.log("\n--- Multi-pack add-on SKUs (--no-skip-multipacks) ---");
    for (const s of buildMultipackCatalog()) {
      const prod = await ensureProduct(s.sku, s.name, "Multi-pack add-on.", {
        kind: "multipack_addon",
        parent_sku: s.parentSku,
      });
      await ensurePrice({
        product: prod, sku: s.sku,
        amountCents: s.amountCents, recurring: s.recurring,
      });
    }
  } else {
    console.log("\n--- Multi-pack add-on SKUs ---");
    console.log("  [skipped] handled as Stripe quantity multiplier in checkout (default).");
    console.log("  Pass --no-skip-multipacks to emit discrete SKUs (24 extra products).");
  }

  // ── Print env-var block ──────────────────────────────────────
  console.log("\n=========================================================");
  console.log("  Done. Paste the block below into:");
  console.log("    1. .env.local                (for local dev + this script)");
  console.log("    2. Vercel project env vars   (Production + Preview + Dev)");
  console.log("    3. Mirror each STRIPE_PRICE_*  as VITE_STRIPE_PRICE_*");
  console.log("       (the React/Astro bundle reads import.meta.env.VITE_*).");
  console.log("=========================================================\n");

  console.log(`# motionmax — Stripe catalog (${MODE} mode)`);
  console.log(`STRIPE_MODE=${MODE}`);
  for (const [k, v] of Object.entries(generated)) {
    console.log(`${k}=${v ?? "<missing>"}`);
  }
  // Mirror VITE_ keys so the browser bundle resolves them.
  console.log("");
  console.log("# Mirror for the React/Astro bundle (VITE_ prefixed):");
  for (const [k, v] of Object.entries(generated)) {
    if (!k.startsWith("STRIPE_PRICE_")) continue;
    console.log(`VITE_${k}=${v ?? "<missing>"}`);
  }
  console.log("");
  if (DRY_RUN) {
    console.log("(Above IDs are placeholder DRYRUN ids — re-run without --dry-run to create real Stripe objects.)");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.message ?? err);
  process.exit(1);
});
