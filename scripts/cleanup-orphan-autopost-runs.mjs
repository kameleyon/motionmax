#!/usr/bin/env node
/**
 * Sweep orphan autopost_runs rows whose schedule_id no longer exists
 * in autopost_schedules — typical residue after a bulk
 * delete-user-projects-* run that cascades through projects →
 * autopost_schedules but leaves the dependent runs / publish_jobs
 * behind. These orphans cause the worker to repeatedly log
 * `autopost_render: run <id> already in terminal status=failed;
 * refusing to re-run` every time the cron tick or stale-claim
 * revival tries to pick them up.
 *
 * Order of deletion (child → parent):
 *   1. autopost_publish_jobs.run_id IN orphan_run_ids
 *   2. autopost_runs WHERE id IN orphan_run_ids
 *
 * Runs WITHOUT a schedule_id are NOT considered orphans here —
 * those are ad-hoc / manual fires and live independently.
 *
 * Usage:
 *   # Dry-run (default — prints what WOULD be deleted):
 *   node scripts/cleanup-orphan-autopost-runs.mjs
 *
 *   # Mutate:
 *   node scripts/cleanup-orphan-autopost-runs.mjs --execute
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const EXECUTE = process.argv.includes("--execute");

const { data: runs, error: e1 } = await sb
  .from("autopost_runs")
  .select("id, schedule_id, status, topic, fired_at");
if (e1) { console.error(e1.message); process.exit(1); }

const { data: schedules, error: e2 } = await sb
  .from("autopost_schedules")
  .select("id");
if (e2) { console.error(e2.message); process.exit(2); }

const liveScheduleIds = new Set((schedules ?? []).map((s) => s.id));
const orphans = (runs ?? []).filter((r) => r.schedule_id && !liveScheduleIds.has(r.schedule_id));

console.log(`\nautopost_runs total:        ${runs?.length ?? 0}`);
console.log(`autopost_schedules total:   ${schedules?.length ?? 0}`);
console.log(`orphans (schedule_id dead): ${orphans.length}\n`);

if (orphans.length === 0) {
  console.log("Nothing to clean up.\n");
  process.exit(0);
}

console.log("── First 15 orphans ──");
for (const o of orphans.slice(0, 15)) {
  console.log(`  ${o.id}  status=${o.status}  fired=${o.fired_at?.slice(0, 19) ?? "?"}  topic=${(o.topic ?? "").slice(0, 60)}`);
}
if (orphans.length > 15) console.log(`  ... and ${orphans.length - 15} more`);

const orphanIds = orphans.map((o) => o.id);

// Count child publish_jobs before deletion so we have a paper trail
const { count: pjCount } = await sb
  .from("autopost_publish_jobs")
  .select("*", { count: "exact", head: true })
  .in("run_id", orphanIds);
console.log(`\nautopost_publish_jobs attached to orphans: ${pjCount ?? 0}`);

if (!EXECUTE) {
  console.log("\nDry-run only. Re-run with --execute to actually delete.\n");
  process.exit(0);
}

console.log("\nProceeding with deletion in 2s...");
await new Promise((r) => setTimeout(r, 2000));

// 1. Delete child publish_jobs first
let pjDeleted = 0;
for (let i = 0; i < orphanIds.length; i += 100) {
  const chunk = orphanIds.slice(i, i + 100);
  const { count, error } = await sb
    .from("autopost_publish_jobs")
    .delete({ count: "exact" })
    .in("run_id", chunk);
  if (error) { console.error(`publish_jobs chunk ${i}: ${error.message}`); break; }
  pjDeleted += count ?? 0;
}
console.log(`✓ autopost_publish_jobs deleted: ${pjDeleted}`);

// 2. Delete the runs themselves
let runDeleted = 0;
for (let i = 0; i < orphanIds.length; i += 100) {
  const chunk = orphanIds.slice(i, i + 100);
  const { count, error } = await sb
    .from("autopost_runs")
    .delete({ count: "exact" })
    .in("id", chunk);
  if (error) { console.error(`runs chunk ${i}: ${error.message}`); break; }
  runDeleted += count ?? 0;
}
console.log(`✓ autopost_runs deleted:         ${runDeleted}\n`);
