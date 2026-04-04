/**
 * Diagnose subscription table state via Supabase Management API
 * Run: node scripts/diagnose-subscriptions.mjs
 */

const PROJECT_REF = "ayjbvcikuwknqdrpsdmj";
const SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";
const MGMT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const REST = `https://${PROJECT_REF}.supabase.co/rest/v1`;

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

async function rest(path) {
  const res = await fetch(`${REST}${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

async function main() {
  console.log("\n=== SUBSCRIPTIONS TABLE (all rows) ===");
  const subs = await sql(`
    SELECT user_id, plan_name, status, stripe_customer_id,
           LEFT(stripe_subscription_id, 30) AS sub_id_preview,
           current_period_end
    FROM subscriptions
    ORDER BY created_at DESC
    LIMIT 30
  `);
  console.table(subs);

  console.log("\n=== STATUS / PLAN BREAKDOWN ===");
  const breakdown = await sql(`
    SELECT plan_name, status, COUNT(*) AS count
    FROM subscriptions
    GROUP BY plan_name, status
    ORDER BY count DESC
  `);
  console.table(breakdown);

  console.log("\n=== USERS WITH active SUBSCRIPTION IN DB ===");
  const active = await sql(`
    SELECT s.user_id, s.plan_name, s.status, s.stripe_customer_id,
           p.email
    FROM subscriptions s
    LEFT JOIN auth.users p ON p.id = s.user_id
    WHERE s.status = 'active'
    LIMIT 20
  `);
  console.table(active);

  console.log("\n=== SAMPLE AUTH USERS + their subscription ===");
  const users = await sql(`
    SELECT u.id, u.email, u.created_at,
           s.plan_name, s.status
    FROM auth.users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    ORDER BY u.created_at DESC
    LIMIT 10
  `);
  console.table(users);

  console.log("\n=== WEBHOOK_EVENTS (last 10 subscription events) ===");
  const events = await sql(`
    SELECT event_id, event_type, created_at
    FROM webhook_events
    WHERE event_type LIKE '%subscription%'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.table(events);
}

main().catch(console.error);
