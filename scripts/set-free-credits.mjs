/**
 * set-free-credits.mjs
 * Gives 10 credits to all users who have no active subscription
 * and currently have fewer than 10 credits.
 *
 * Run: node scripts/set-free-credits.mjs
 */

const MGMT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const PROJECT_REF = "ayjbvcikuwknqdrpsdmj";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const FREE_CREDITS = 10;

async function sql(query) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MGMT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function main() {
  console.log("\n🔍 Finding free-tier users with < 10 credits...");

  // Find users with no active subscription and < 10 credits (or no credits row at all)
  const freeUsers = await sql(`
    SELECT u.id, u.email, COALESCE(uc.credits_balance, 0) AS credits
    FROM auth.users u
    LEFT JOIN public.subscriptions s
      ON s.user_id = u.id AND s.status = 'active'
    LEFT JOIN public.user_credits uc
      ON uc.user_id = u.id
    WHERE s.user_id IS NULL
      AND COALESCE(uc.credits_balance, 0) < ${FREE_CREDITS}
    ORDER BY u.created_at DESC
  `);

  if (!freeUsers || freeUsers.length === 0) {
    console.log("✅ No free users with < 10 credits found.");
    return;
  }

  console.log(`Found ${freeUsers.length} user(s) to update.`);
  console.table(freeUsers);

  // Upsert 10 credits for each
  const ids = freeUsers.map((u) => `'${u.id}'`).join(", ");
  const result = await sql(`
    INSERT INTO public.user_credits (user_id, credits_balance)
    SELECT id, ${FREE_CREDITS} FROM auth.users WHERE id IN (${ids})
    ON CONFLICT (user_id) DO UPDATE SET
      credits_balance = ${FREE_CREDITS}
    RETURNING user_id, credits_balance
  `);

  console.log(`✅ Updated ${result.length} user(s) to ${FREE_CREDITS} credits.`);
  console.table(result);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
