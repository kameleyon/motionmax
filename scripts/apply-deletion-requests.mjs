/**
 * Process pending account deletion requests.
 *
 * Calls the process_due_deletions() database function which:
 * 1. Finds all deletion_requests where scheduled_at <= NOW()
 * 2. Deletes user storage files from all buckets
 * 3. Deletes the auth.users record (cascading FKs clean up DB tables)
 * 4. Marks the deletion request as completed
 *
 * Run manually: node scripts/apply-deletion-requests.mjs
 * Or schedule via cron / CI pipeline.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY env vars.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log("[Deletion] Processing due deletion requests...");

  // Call the database function that handles everything atomically
  const { data, error } = await supabase.rpc("process_due_deletions");

  if (error) {
    console.error("[Deletion] Error:", error.message);
    process.exit(1);
  }

  console.log(`[Deletion] Processed ${data} deletion request(s)`);

  // Also run full data retention sweep
  console.log("[Retention] Running data retention policies...");
  const { data: retentionResult, error: retentionError } = await supabase.rpc("run_data_retention");

  if (retentionError) {
    console.error("[Retention] Error:", retentionError.message);
  } else {
    console.log("[Retention] Results:", JSON.stringify(retentionResult, null, 2));
  }
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
