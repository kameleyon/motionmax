#!/usr/bin/env node
// Comprehensive one-shot storage cleanup. Two passes:
//
//   Pass 1: SHIPPED projects untouched for N days. Deletes intermediates
//           (scene-images, audio, scene-videos) for projects where
//           `previous_export_url IS NOT NULL AND updated_at < N days ago`.
//           The final export in `videos/` is never touched.
//
//   Pass 2: ORPHAN folders. Deletes intermediate folders whose UUID
//           prefix no longer corresponds to a row in public.projects
//           (i.e. the project was bulk-deleted but storage wasn't
//           cascaded). Catches the 0.6 GB the earlier inventory found.
//
// Usage:
//   node scripts/run-storage-cleanup.mjs                   # dry-run, 7d policy
//   node scripts/run-storage-cleanup.mjs --execute         # actually delete
//   node scripts/run-storage-cleanup.mjs --days 14         # tighter window
//   node scripts/run-storage-cleanup.mjs --no-orphans      # pass 1 only
//   node scripts/run-storage-cleanup.mjs --orphans-only    # pass 2 only
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env. Source
// from worker/.env via `set -a && source worker/.env && set +a`.
import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const noOrphans = argv.includes("--no-orphans");
const orphansOnly = argv.includes("--orphans-only");
const daysIdx = argv.indexOf("--days");
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 7;
if (!Number.isFinite(days) || days < 0) {
  console.error("Invalid --days value");
  process.exit(1);
}

const BUCKETS = ["scene-images", "audio", "scene-videos"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;

console.log(`▶ mode = ${execute ? "EXECUTE" : "DRY-RUN"}`);
console.log(`▶ policy = shipped projects untouched for ${days}+ days`);
console.log(`▶ orphan pass = ${noOrphans ? "skip" : "yes"}\n`);

let grandFiles = 0;
let grandBytes = 0;
const errors = [];

// ───── PASS 1: shipped + idle projects ─────
if (!orphansOnly) {
  console.log(`━━━ PASS 1: shipped projects untouched ${days}+ days ━━━`);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // previous_export_url is not nullable for shipped projects.
  const { data: shipped, error } = await sb
    .from("projects")
    .select("id, updated_at")
    .not("previous_export_url", "is", null)
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true });
  if (error) { console.error("query failed:", error.message); process.exit(1); }
  console.log(`  ${shipped.length} shipped project(s) match.\n`);

  let p1Files = 0, p1Bytes = 0;
  for (let i = 0; i < shipped.length; i++) {
    const p = shipped[i];
    const { files, bytes, errs } = await cleanProjectIntermediates(p.id, execute);
    p1Files += files; p1Bytes += bytes;
    errors.push(...errs);
    if ((i + 1) % 20 === 0 || i === shipped.length - 1) {
      console.log(`  [${i + 1}/${shipped.length}] running total: ${(p1Bytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${p1Files} files`);
    }
  }
  console.log(`  ── PASS 1 done: ${(p1Bytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${p1Files} files\n`);
  grandFiles += p1Files; grandBytes += p1Bytes;
}

// ───── PASS 2: orphans ─────
if (!noOrphans) {
  console.log(`━━━ PASS 2: orphaned folders (no DB row) ━━━`);

  // Build the live-project ID set.
  const livePids = new Set();
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("projects").select("id").range(from, from + PAGE - 1);
    if (error) { console.error("projects query:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const r of data) livePids.add(r.id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  Live projects in DB: ${livePids.size}\n`);

  let p2Files = 0, p2Bytes = 0;
  for (const bucket of BUCKETS) {
    const prefixes = await listTopLevelFolders(bucket);
    let orphanCount = 0;
    for (const prefix of prefixes) {
      if (!UUID_RE.test(prefix)) continue;
      if (livePids.has(prefix)) continue;
      orphanCount++;
      const { files, bytes, errs } = await cleanFolder(bucket, prefix, execute);
      p2Files += files; p2Bytes += bytes;
      errors.push(...errs);
    }
    console.log(`  ${bucket}: ${orphanCount} orphan folder(s) handled`);
  }
  console.log(`  ── PASS 2 done: ${(p2Bytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${p2Files} files\n`);
  grandFiles += p2Files; grandBytes += p2Bytes;
}

console.log(`═══ GRAND TOTAL ═══`);
console.log(`  Files ${execute ? "deleted" : "would-delete"}: ${grandFiles}`);
console.log(`  Bytes ${execute ? "freed"   : "would-free"}:   ${(grandBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
if (errors.length) {
  console.log(`  Errors: ${errors.length} (first 5 shown)`);
  for (const e of errors.slice(0, 5)) console.log(`    - ${JSON.stringify(e)}`);
}
if (!execute) console.log(`\n(re-run with --execute to actually delete)`);

// ───── helpers ─────

async function cleanProjectIntermediates(projectId, execute) {
  let files = 0, bytes = 0;
  const errs = [];
  for (const bucket of BUCKETS) {
    try {
      const r = await cleanFolder(bucket, projectId, execute);
      files += r.files; bytes += r.bytes; errs.push(...r.errs);
    } catch (e) {
      errs.push({ project: projectId, bucket, error: e.message });
    }
  }
  return { files, bytes, errs };
}

async function cleanFolder(bucket, prefix, execute) {
  let files = 0, bytes = 0;
  const errs = [];
  let pageIdx = 0;
  const allPaths = [];
  for (;;) {
    const { data: entries, error } = await sb.storage.from(bucket).list(prefix, {
      limit: PAGE, offset: pageIdx * PAGE, sortBy: { column: "name", order: "asc" },
    });
    if (error) { errs.push({ bucket, prefix, error: error.message }); return { files, bytes, errs }; }
    if (!entries || entries.length === 0) break;
    for (const e of entries) {
      // entries with id=null and metadata=null are sub-folders. Recurse for those.
      if (e.id === null && (e.metadata === null || e.metadata === undefined)) {
        const sub = await cleanFolder(bucket, `${prefix}/${e.name}`, execute);
        files += sub.files; bytes += sub.bytes; errs.push(...sub.errs);
      } else {
        allPaths.push(`${prefix}/${e.name}`);
        bytes += e.metadata?.size ?? 0;
        files += 1;
      }
    }
    if (entries.length < PAGE) break;
    pageIdx++;
  }
  if (execute && allPaths.length > 0) {
    for (let i = 0; i < allPaths.length; i += 1000) {
      const batch = allPaths.slice(i, i + 1000);
      const { error: rmErr } = await sb.storage.from(bucket).remove(batch);
      if (rmErr) errs.push({ bucket, prefix, removeError: rmErr.message });
    }
  }
  return { files, bytes, errs };
}

async function listTopLevelFolders(bucket) {
  const out = [];
  let pageIdx = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(bucket).list("", {
      limit: PAGE, offset: pageIdx * PAGE, sortBy: { column: "name", order: "asc" },
    });
    if (error) { console.error(`list ${bucket} root: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const e of data) out.push(e.name);
    if (data.length < PAGE) break;
    pageIdx++;
  }
  return out;
}
