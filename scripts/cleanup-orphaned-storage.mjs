#!/usr/bin/env node
/**
 * Delete Storage objects that belong to projects which no longer exist.
 *
 * The project-scoped buckets key every object under a `{projectId}/…`
 * prefix. After deleting old projects from the DB, those files are
 * orphaned (the S3 bytes remain and are still billed). This script finds
 * any top-level folder that is a UUID NOT present in `projects` and
 * removes everything under it — via the Storage API, so the actual bytes
 * are freed (deleting `storage.objects` rows in SQL would NOT free S3).
 *
 * It ALSO handles the `videos` bucket's `exports/export_<projectId>_…mp4`
 * files (projectId embedded in the filename).
 *
 * LEFT ALONE (not project-scoped): voice-preview/, uploads/, transitions/,
 * audio-files/, autopost-thumbnails/, voice_samples/, style-references/,
 * and userId-keyed lipsync files in `videos`.
 *
 * DRY RUN by default — prints what it WOULD delete. Pass --apply to delete.
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Usage:
 *   node scripts/cleanup-orphaned-storage.mjs            # dry run (safe)
 *   node scripts/cleanup-orphaned-storage.mjs --apply     # actually delete
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");

const sb = createClient(URL, KEY, { auth: { persistSession: false } });

// Buckets whose top-level folder name IS a projectId.
const PROJECT_BUCKETS = ["scene-images", "audio", "scene-videos", "project-thumbnails"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_PAGE = 1000;
const REMOVE_BATCH = 900;

/** Every current projects.id (paginated). */
async function currentProjectIds() {
  const ids = new Set();
  for (let from = 0; ; from += LIST_PAGE) {
    const { data, error } = await sb.from("projects").select("id").range(from, from + LIST_PAGE - 1);
    if (error) throw new Error(`projects fetch: ${error.message}`);
    data.forEach((r) => ids.add(r.id));
    if (data.length < LIST_PAGE) break;
  }
  return ids;
}

/** Paginated list of immediate children of `prefix`. */
async function listPage(bucket, prefix) {
  const entries = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    entries.push(...data);
    if (data.length < LIST_PAGE) break;
  }
  return entries;
}

/** Recursively collect every FILE path under `prefix` (folders have id===null). */
async function listAllFiles(bucket, prefix) {
  const out = [];
  for (const entry of await listPage(bucket, prefix)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) out.push(...(await listAllFiles(bucket, path)));
    else out.push(path);
  }
  return out;
}

async function removeInBatches(bucket, paths) {
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const slice = paths.slice(i, i + REMOVE_BATCH);
    const { error } = await sb.storage.from(bucket).remove(slice);
    if (error) throw new Error(`remove ${bucket}: ${error.message}`);
    console.log(`   removed ${Math.min(i + REMOVE_BATCH, paths.length)}/${paths.length}`);
  }
}

const alive = await currentProjectIds();
console.log(`Current projects: ${alive.size}`);
console.log(APPLY ? "MODE: APPLY — deleting orphaned objects\n" : "MODE: DRY RUN — pass --apply to actually delete\n");

let grandTotal = 0;

// ── Project-folder buckets ─────────────────────────────────────────
for (const bucket of PROJECT_BUCKETS) {
  const top = await listPage(bucket, "");
  const orphanPrefixes = top
    .filter((e) => e.id === null && UUID.test(e.name) && !alive.has(e.name))
    .map((e) => e.name);
  let paths = [];
  for (const prefix of orphanPrefixes) paths.push(...(await listAllFiles(bucket, prefix)));
  console.log(`[${bucket}] ${orphanPrefixes.length} orphaned folder(s), ${paths.length} object(s)`);
  grandTotal += paths.length;
  if (APPLY && paths.length) await removeInBatches(bucket, paths);
}

// ── videos/exports (projectId embedded in filename) ────────────────
{
  const bucket = "videos";
  const files = await listAllFiles(bucket, "exports");
  const orphans = files.filter((p) => {
    const m = p.match(/export_([0-9a-f-]{36})_/i);
    return m && !alive.has(m[1]);
  });
  console.log(`[${bucket}/exports] ${orphans.length} orphaned export(s)`);
  grandTotal += orphans.length;
  if (APPLY && orphans.length) await removeInBatches(bucket, orphans);
}

console.log(`\n${APPLY ? "Removed" : "Would remove"} ${grandTotal} orphaned object(s).`);
if (!APPLY) console.log("Re-run with --apply to delete them.");
