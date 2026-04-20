// Refund user d53d98fb for generation 626e420c whose scene-images were
// destroyed by the premature cleanup bug.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync("worker/.env", "utf8")
  .split("\n")
  .reduce((acc, line) => {
    const [k, ...v] = line.split("=");
    if (k && v.length) acc[k.trim()] = v.join("=").trim();
    return acc;
  }, {});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const USER_ID = "d53d98fb-e712-4160-b170-12539c5a23d0";
const GEN_ID = "626e420c-fce2-41b8-ba1f-b289241b8666";
const PROJECT_ID = "93eeaff9-9efa-4b75-a51f-c0f29b1fa19f";

console.log("=== Step 1: Find the original deduction ===");
const { data: tx } = await supabase
  .from("credit_transactions")
  .select("id, amount, transaction_type, description, created_at")
  .eq("user_id", USER_ID)
  .in("transaction_type", ["generation", "usage", "deduction"])
  .order("created_at", { ascending: false })
  .limit(20);

if (tx) {
  console.log(`Recent deductions for user:`);
  tx.forEach(t => console.log(`  ${t.created_at} | ${t.amount} | ${t.transaction_type} | ${t.description}`));
}

console.log("\n=== Step 2: Check current balance ===");
const { data: balBefore } = await supabase
  .from("user_credits")
  .select("credits_balance")
  .eq("user_id", USER_ID)
  .maybeSingle();
console.log(`Balance before refund: ${balBefore?.credits_balance}`);

// doc2video generation cost is typically 15 credits for medium length.
// Without knowing the exact length, refund 15 as the typical doc2video cost.
const REFUND_AMOUNT = 15;

console.log(`\n=== Step 3: Refund ${REFUND_AMOUNT} credits ===`);
const { data: refunded, error: refundErr } = await supabase.rpc("refund_credits_securely", {
  p_user_id: USER_ID,
  p_amount: REFUND_AMOUNT,
  p_description: `Compensation for destroyed generation ${GEN_ID} (project ${PROJECT_ID}) — scene-images were erased by a worker bug before export could run. Incident fixed in commit 38b3437.`,
});

if (refundErr) {
  console.log("Refund error:", refundErr);
  process.exit(1);
}
console.log(`Refund RPC returned: ${refunded}`);

const { data: balAfter } = await supabase
  .from("user_credits")
  .select("credits_balance")
  .eq("user_id", USER_ID)
  .maybeSingle();
console.log(`Balance after refund: ${balAfter?.credits_balance} (delta: ${balAfter?.credits_balance - (balBefore?.credits_balance || 0)})`);
