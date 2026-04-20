// The destroyed generation was -150 credits (doc2video short), not 15.
// Issue the missing 135 to complete the refund.
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

const { data } = await supabase.rpc("refund_credits_securely", {
  p_user_id: "d53d98fb-e712-4160-b170-12539c5a23d0",
  p_amount: 135,
  p_description: "Top-up: destroyed generation 626e420c cost 150 credits total (15 already refunded)",
});
console.log("Top-up result:", data);

const { data: bal } = await supabase
  .from("user_credits")
  .select("credits_balance")
  .eq("user_id", "d53d98fb-e712-4160-b170-12539c5a23d0")
  .maybeSingle();
console.log("Final balance:", bal?.credits_balance);
