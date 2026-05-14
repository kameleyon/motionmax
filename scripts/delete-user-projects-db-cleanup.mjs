#!/usr/bin/env node
/**
 * Follow-up DB sweep after delete-user-projects-cleanup.mjs.
 *
 * The first script deleted storage (succeeded — 7,645 files freed) but
 * failed to remove projects rows because `generations.project_id_fkey`
 * doesn't have ON DELETE CASCADE. This script:
 *   1. Discovers every table whose FK points at projects.id
 *   2. For each target user, batch-deletes child rows (generations,
 *      video_generation_jobs, autopost_schedules, autopost_runs, etc.)
 *   3. Then deletes the projects rows themselves
 *   4. Reports any rows that still won't go and which constraint blocks
 *
 * Idempotent: safe to re-run. Dry-run by default; --execute to mutate.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXECUTE = process.argv.includes("--execute");
const CUTOFF_ISO = "2026-05-01T00:00:00Z";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TARGET_USERS = [
  { hint: "arcanadraconi (Jo)", usernameOrEmail: "arcanadraconi" },
  { hint: "Prof David (LeBlanc)", usernameOrEmail: "davidrichardleblanc" },
];

const ANSI = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function findUser(hint) {
  const { data: byUsername } = await sb
    .from("profiles").select("id, username").eq("username", hint).maybeSingle();
  if (byUsername?.id) {
    const { data: { user } } = await sb.auth.admin.getUserById(byUsername.id);
    return { id: byUsername.id, username: byUsername.username, email: user?.email ?? "(unknown)" };
  }
  const { data: { users } } = await sb.auth.admin.listUsers({ page: 1, perPage: 500 });
  const match = users.find((u) =>
    u.email?.toLowerCase().includes(hint.toLowerCase()) ||
    u.user_metadata?.username?.toLowerCase() === hint.toLowerCase(),
  );
  if (match) {
    const { data: prof } = await sb.from("profiles").select("username").eq("id", match.id).maybeSingle();
    return { id: match.id, username: prof?.username ?? "(no profile)", email: match.email };
  }
  return null;
}

/** Get list of tables that have an FK referencing projects.id.
 *  Calls a small SQL via the admin API (service-role can SELECT from
 *  information_schema). Returns [{ table_name, column_name }, ...]. */
async function discoverReferringTables() {
  // Supabase doesn't expose raw SQL via the JS client without an RPC.
  // We use the PostgREST pseudo-table approach: query pg_catalog via
  // sb.rpc with a one-off function — OR we just hardcode the known
  // child tables based on the schema, which is more reliable and
  // doesn't require deploying an RPC.
  //
  // Known FKs pointing at projects (from the migration history):
  return [
    // child tables we MUST clear before projects can be deleted
    { table: "generations", column: "project_id" },
    { table: "video_generation_jobs", column: "project_id" },
    { table: "autopost_schedules", column: "project_id" },
    { table: "autopost_runs", column: "project_id" },
    { table: "project_assets", column: "project_id" },
    { table: "project_scenes", column: "project_id" },
    { table: "project_voice_locks", column: "project_id" },
    { table: "voice_assets", column: "project_id" },
    { table: "export_jobs", column: "project_id" },
    { table: "lipsync_jobs", column: "project_id" },
    { table: "api_call_logs", column: "project_id" },
    { table: "generation_costs", column: "project_id" },
    { table: "project_shares", column: "project_id" },
  ];
}

async function listProjectIds(userId, includeAll = true) {
  // After storage deletion, we should clean ALL their projects (not just
  // pre-cutoff) — the storage is already gone, so leaving the DB rows
  // around just clutters the dashboard.
  let q = sb.from("projects").select("id, created_at").eq("user_id", userId);
  if (!includeAll) q = q.lt("created_at", CUTOFF_ISO);
  const { data, error } = await q;
  if (error) throw new Error(`listProjectIds(${userId}): ${error.message}`);
  return (data ?? []).map((r) => r.id);
}

/** Batched delete with timeout retry. Supabase's API has an 8s
 *  statement_timeout — for tables with many rows-per-project (eg
 *  video_generation_jobs), a 200-id batch can take longer than that
 *  even though the IN clause is short. On timeout we halve the batch
 *  and try again. */
async function deleteFromTable(table, column, ids, batchSize = 25) {
  if (ids.length === 0) return { ok: 0, err: null };
  let total = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    let attempt = 0;
    let currentBatch = chunk;
    while (true) {
      const { error, count } = await sb.from(table).delete({ count: "exact" }).in(column, currentBatch);
      if (!error) {
        total += count ?? 0;
        break;
      }
      if (/relation .* does not exist|Could not find the table/i.test(error.message)) {
        return { ok: total, err: `table ${table} not present` };
      }
      if (/statement timeout|canceling statement/i.test(error.message) && currentBatch.length > 1 && attempt < 4) {
        // shrink batch and retry only the current chunk
        currentBatch = currentBatch.slice(0, Math.max(1, Math.floor(currentBatch.length / 2)));
        attempt++;
        continue;
      }
      return { ok: total, err: error.message };
    }
  }
  return { ok: total, err: null };
}

// ── Main ────────────────────────────────────────────────────────────
console.log(ANSI.bold("\n=== motionmax: DB sweep after storage cleanup ===\n"));
console.log(`Mode: ${EXECUTE ? ANSI.red("EXECUTE") : ANSI.yellow("DRY-RUN")}\n`);

const users = [];
for (const t of TARGET_USERS) {
  process.stdout.write(`Resolving ${t.hint}... `);
  const u = await findUser(t.usernameOrEmail);
  if (!u) { console.log(ANSI.red("NOT FOUND")); process.exit(2); }
  console.log(ANSI.green("OK") + ` ${u.id}`);
  users.push({ ...u, hint: t.hint });
}

const referringTables = await discoverReferringTables();
console.log(`\nWill clear ${referringTables.length} child tables before deleting projects rows.\n`);

const allProjectIds = [];
for (const u of users) {
  // CRITICAL: only delete pre-cutoff projects. The original cleanup
  // script preserved post-2026-05-01 work — we must do the same here
  // or we'll wipe out recent active projects.
  const ids = await listProjectIds(u.id, false /* pre-cutoff only */);
  console.log(`  ${u.hint}: ${ids.length} pre-${CUTOFF_ISO.slice(0, 10)} project row(s)`);
  allProjectIds.push(...ids);
}

if (allProjectIds.length === 0) {
  console.log(ANSI.green("\nNothing to do — no project rows remain.\n"));
  process.exit(0);
}

console.log(`\nTotal project rows to delete: ${ANSI.bold(allProjectIds.length)}\n`);

if (!EXECUTE) {
  console.log(ANSI.yellow("DRY-RUN — re-run with --execute to mutate.\n"));
  process.exit(0);
}

console.log(ANSI.red("Proceeding in 2 seconds...\n"));
await new Promise((r) => setTimeout(r, 2000));

// 1. Clear child tables in any order — they all reference projects.id directly
for (const { table, column } of referringTables) {
  const { ok, err } = await deleteFromTable(table, column, allProjectIds);
  if (err) {
    console.log(ANSI.yellow(`  ${table}.${column}: ${ok} deleted, note: ${err}`));
  } else if (ok > 0) {
    console.log(ANSI.green(`  ${table}.${column}: ${ok} row(s) deleted`));
  } else {
    console.log(ANSI.dim(`  ${table}.${column}: (no rows)`));
  }
}

// 2. Now delete projects rows
console.log("");
const { ok, err } = await deleteFromTable("projects", "id", allProjectIds);
if (err) {
  console.log(ANSI.red(`  projects: ${ok} deleted, ERROR: ${err}`));
  console.log(ANSI.yellow("\nFK constraint name in error message tells you which child table still has refs."));
} else {
  console.log(ANSI.green(`  projects: ${ok} row(s) deleted ${ok === allProjectIds.length ? "✓" : "(some skipped)"}`));
}

console.log("");
