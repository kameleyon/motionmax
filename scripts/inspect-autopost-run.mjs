#!/usr/bin/env node
/**
 * Inspect an autopost run + optionally trigger a fresh re-run via the
 * autopost_fire_now RPC. The RPC creates a brand-new autopost_runs row
 * (the old failed/cancelled run stays in history for diagnosis); this
 * sidesteps the handler's idempotency guard that refuses to re-run
 * terminal-state rows.
 *
 * Usage:
 *   # Inspect only:
 *   node scripts/inspect-autopost-run.mjs <run-id>
 *
 *   # Inspect + retry by firing a new run for the same schedule:
 *   node scripts/inspect-autopost-run.mjs <run-id> --retry
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const runId = process.argv[2];
const retry = process.argv.includes("--retry");
if (!runId) { console.error("Usage: ... <run-id> [--retry]"); process.exit(1); }

const { data: run, error: runErr } = await sb
  .from("autopost_runs")
  .select("*")
  .eq("id", runId)
  .maybeSingle();
if (runErr || !run) { console.error("Run not found:", runErr?.message); process.exit(2); }

console.log("\n── autopost_runs row ────────────");
for (const [k, v] of Object.entries(run)) {
  const val = v === null ? "(null)"
    : typeof v === "object" ? JSON.stringify(v).slice(0, 300)
    : String(v).slice(0, 300);
  console.log(`  ${k.padEnd(28)} ${val}`);
}

const { data: jobs } = await sb
  .from("autopost_publish_jobs")
  .select("*")
  .eq("run_id", runId)
  .order("created_at", { ascending: true });

console.log(`\n── autopost_publish_jobs (${jobs?.length ?? 0}) ────────────`);
for (const j of jobs ?? []) {
  console.log(`\n  job ${j.id}  platform=${j.platform}  status=${j.status}`);
  if (j.error_message) console.log(`    error: ${j.error_message}`);
  if (j.error_details) console.log(`    details: ${JSON.stringify(j.error_details).slice(0, 400)}`);
}

if (!run.schedule_id) { console.log("\n  No schedule_id — cannot retry."); process.exit(3); }

const { data: schedule } = await sb
  .from("autopost_schedules")
  .select("id, user_id, name, status, next_fire_at, last_fire_at, platforms")
  .eq("id", run.schedule_id)
  .maybeSingle();
if (schedule) {
  console.log("\n── parent autopost_schedules row ────────────");
  for (const [k, v] of Object.entries(schedule)) {
    console.log(`  ${k.padEnd(20)} ${v === null ? "(null)" : typeof v === "object" ? JSON.stringify(v) : v}`);
  }
}

if (!retry) {
  console.log("\nPass --retry to fire a fresh run for this schedule.\n");
  process.exit(0);
}

if (!schedule) { console.error("Schedule row not found — cannot fire retry."); process.exit(4); }
if (schedule.status !== "active") {
  console.error(`Refusing to retry: schedule status is "${schedule.status}", expected "active".`);
  process.exit(5);
}

console.log("\n▶ Calling autopost_fire_now(schedule_id)...");
const { data: newRunId, error: rpcErr } = await sb.rpc("autopost_fire_now", {
  p_schedule_id: schedule.id,
});
if (rpcErr) { console.error("RPC failed:", rpcErr.message); process.exit(6); }

console.log(`\n✓ New run enqueued: ${newRunId}`);
console.log("  Worker picks up the autopost_render job on next claim cycle.");
console.log("  Poll progress with:");
console.log(`    node scripts/inspect-autopost-run.mjs ${newRunId}\n`);
