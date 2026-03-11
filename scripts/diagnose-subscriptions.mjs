/**
 * Diagnose why users show "free" plan.
 * Run: node scripts/diagnose-subscriptions.mjs
 */
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import "dotenv/config";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !STRIPE_KEY) {
  console.error("Missing env vars: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STRIPE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const stripe = new Stripe(STRIPE_KEY, { apiVersion: "2023-10-16" });

async function main() {
  console.log("\n=== SUBSCRIPTIONS TABLE ===");
  const { data: subs, error: subsErr } = await supabase
    .from("subscriptions")
    .select("user_id, plan_name, status, stripe_customer_id, stripe_subscription_id, current_period_end")
    .order("created_at", { ascending: false })
    .limit(20);

  if (subsErr) {
    console.error("DB error:", subsErr.message);
  } else {
    console.table(subs);
  }

  console.log("\n=== STATUS BREAKDOWN ===");
  const { data: counts } = await supabase
    .from("subscriptions")
    .select("status, plan_name");

  if (counts) {
    const grouped = counts.reduce((acc, row) => {
      const key = `${row.plan_name}/${row.status}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.table(grouped);
  }

  console.log("\n=== STRIPE ACTIVE SUBSCRIPTIONS (first 10) ===");
  try {
    const stripeSubs = await stripe.subscriptions.list({ status: "active", limit: 10 });
    for (const sub of stripeSubs.data) {
      const item = sub.items.data[0];
      const productRaw = item?.price?.product;
      const productId = typeof productRaw === "string" ? productRaw : productRaw?.id ?? "UNKNOWN";
      console.log({
        id: sub.id,
        customer: sub.customer,
        productId,
        status: sub.status,
        periodEnd: new Date(sub.current_period_end * 1000).toISOString(),
      });
    }
  } catch (e) {
    console.error("Stripe error:", e.message);
  }

  console.log("\n=== AUTH USERS WITH NO SUBSCRIPTION RECORD ===");
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email")
    .limit(10);

  if (profiles) {
    for (const p of profiles) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("plan_name, status")
        .eq("user_id", p.id)
        .maybeSingle();
      console.log({ email: p.email, sub: sub ? `${sub.plan_name}/${sub.status}` : "NO RECORD" });
    }
  }
}

main().catch(console.error);
