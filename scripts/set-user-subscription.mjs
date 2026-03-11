/**
 * set-user-subscription.mjs
 * Sets urbanbrujetta4ever@gmail.com to creator plan
 * with subscription renewal on March 13, 2026 at midnight UTC.
 *
 * Run: node scripts/set-user-subscription.mjs
 */

const MGMT_TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";
const PROJECT_REF = "ayjbvcikuwknqdrpsdmj";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const TARGET_EMAIL = "urbanbrujetta4ever@gmail.com";
// March 13, 2026 at midnight UTC
const RENEWAL_DATE = "2026-03-13T00:00:00.000Z";
// Creator plan gets 100 credits
const CREATOR_CREDITS = 100;

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
  console.log(`\n🔍 Looking up user: ${TARGET_EMAIL}`);

  const users = await sql(
    `SELECT id, email FROM auth.users WHERE email = '${TARGET_EMAIL}' LIMIT 1`
  );

  if (!users || users.length === 0) {
    console.error("❌ User not found:", TARGET_EMAIL);
    process.exit(1);
  }

  const userId = users[0].id;
  console.log(`✅ Found user: ${userId}`);

  // Check if a subscription row already exists for this user
  const existing = await sql(
    `SELECT id FROM public.subscriptions WHERE user_id = '${userId}' LIMIT 1`
  );

  let subResult;
  if (existing && existing.length > 0) {
    const rowId = existing[0].id;
    console.log(`   Found existing subscription row: ${rowId}`);
    subResult = await sql(`
      UPDATE public.subscriptions SET
        plan_name            = 'creator',
        status               = 'active',
        stripe_subscription_id = 'manual_creator_urbanbrujetta4ever',
        current_period_end   = '${RENEWAL_DATE}',
        cancel_at_period_end = false,
        updated_at           = now()
      WHERE id = '${rowId}'
      RETURNING user_id, plan_name, status, current_period_end
    `);
  } else {
    const subId = `manual_creator_${userId.slice(0, 8)}`;
    subResult = await sql(`
      INSERT INTO public.subscriptions (
        user_id, plan_name, status, stripe_subscription_id,
        current_period_end, cancel_at_period_end,
        stripe_customer_id, current_period_start
      )
      VALUES (
        '${userId}', 'creator', 'active', '${subId}',
        '${RENEWAL_DATE}', false,
        'manual_${userId.slice(0, 8)}', now()
      )
      RETURNING user_id, plan_name, status, current_period_end
    `);
  }
  console.log("✅ Subscription set:", subResult);

  // Ensure credits are set to creator level (keep higher if already above)
  const creditsResult = await sql(`
    INSERT INTO public.user_credits (user_id, credits_balance)
    VALUES ('${userId}', ${CREATOR_CREDITS})
    ON CONFLICT (user_id) DO UPDATE SET
      credits_balance = GREATEST(user_credits.credits_balance, ${CREATOR_CREDITS})
    RETURNING user_id, credits_balance
  `);
  console.log("✅ Credits set:", creditsResult);

  console.log(`\n🎉 Done! ${TARGET_EMAIL} is now on creator plan.`);
  console.log(`   Renewal date : ${RENEWAL_DATE}`);
  console.log(`   Credits      : ${creditsResult[0]?.credits_balance ?? CREATOR_CREDITS}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
