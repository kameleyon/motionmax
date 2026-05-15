#!/usr/bin/env node
// Inventory storage to find ORPHANED top-level prefixes — folders
// whose name (a project UUID) no longer corresponds to a row in
// public.projects. The bulk-deletion script we ran earlier today
// removed DB rows but storage isn't FK-cascaded, so files can sit
// here taking space indefinitely.
//
// Buckets walked: scene-images, audio, scene-videos. Final
// `videos/` bucket is intentionally NOT scanned — its layout is
// flat (not `<projectId>/...`), and users keep their exports.
//
// Usage:  node scripts/inventory-storage-orphans.mjs
//         node scripts/inventory-storage-orphans.mjs --execute   # actually delete
import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const execute = process.argv.includes("--execute");
const BUCKETS = ["scene-images", "audio", "scene-videos"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

console.log(`▶ mode = ${execute ? "EXECUTE (will delete)" : "DRY-RUN (no deletes)"}\n`);

// 1. Get the universe of live project IDs in one shot.
const livePids = new Set();
let from = 0;
const PAGE = 1000;
for (;;) {
  const { data, error } = await sb
    .from("projects")
    .select("id")
    .range(from, from + PAGE - 1);
  if (error) { console.error("projects query:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  for (const r of data) livePids.add(r.id);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`Live projects in DB: ${livePids.size}\n`);

// 2. For each intermediate bucket, list top-level prefixes (returned
//    by storage.list("", ...) — directories show up as entries with
//    metadata=null and id=null). Cross-reference with livePids.
const overallReport = {};
let grandOrphanFiles = 0;
let grandOrphanBytes = 0;

for (const bucket of BUCKETS) {
  console.log(`━━━ ${bucket} ━━━`);
  const prefixes = await listTopLevelFolders(bucket);
  let liveCount = 0;
  let orphanCount = 0;
  let orphanFiles = 0;
  let orphanBytes = 0;

  for (const prefix of prefixes) {
    if (!UUID_RE.test(prefix)) continue; // skip non-UUID folders (shouldn't exist but be safe)
    const isLive = livePids.has(prefix);
    if (isLive) { liveCount++; continue; }
    orphanCount++;

    // Tally the orphan's files + bytes.
    let pageIdx = 0;
    const allPaths = [];
    let folderBytes = 0;
    for (;;) {
      const { data: entries, error } = await sb.storage
        .from(bucket)
        .list(prefix, { limit: PAGE, offset: pageIdx * PAGE, sortBy: { column: "name", order: "asc" } });
      if (error) { console.error(`  list ${bucket}/${prefix}: ${error.message}`); break; }
      if (!entries || entries.length === 0) break;
      for (const e of entries) {
        allPaths.push(`${prefix}/${e.name}`);
        folderBytes += e.metadata?.size ?? 0;
      }
      if (entries.length < PAGE) break;
      pageIdx++;
    }
    orphanFiles += allPaths.length;
    orphanBytes += folderBytes;

    if (execute && allPaths.length > 0) {
      // Delete in 1000-path batches (Supabase remove() max).
      for (let i = 0; i < allPaths.length; i += 1000) {
        const batch = allPaths.slice(i, i + 1000);
        const { error: rmErr } = await sb.storage.from(bucket).remove(batch);
        if (rmErr) console.error(`  remove batch (${prefix}): ${rmErr.message}`);
      }
    }
  }

  console.log(`  Live folders:   ${liveCount}`);
  console.log(`  Orphan folders: ${orphanCount}`);
  console.log(`  Orphan files:   ${orphanFiles}`);
  console.log(`  Orphan size:    ${(orphanBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log("");
  overallReport[bucket] = { liveCount, orphanCount, orphanFiles, orphanBytes };
  grandOrphanFiles += orphanFiles;
  grandOrphanBytes += orphanBytes;
}

console.log(`═══ GRAND TOTAL ═══`);
console.log(`  Orphan files: ${grandOrphanFiles}`);
console.log(`  Orphan size:  ${(grandOrphanBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
if (!execute) console.log(`\n(re-run with --execute to delete)`);

async function listTopLevelFolders(bucket) {
  const out = [];
  let pageIdx = 0;
  for (;;) {
    const { data: entries, error } = await sb.storage
      .from(bucket)
      .list("", { limit: PAGE, offset: pageIdx * PAGE, sortBy: { column: "name", order: "asc" } });
    if (error) { console.error(`  list ${bucket} root: ${error.message}`); break; }
    if (!entries || entries.length === 0) break;
    // storage.list at root returns folders as entries with id=null + metadata=null.
    for (const e of entries) out.push(e.name);
    if (entries.length < PAGE) break;
    pageIdx++;
  }
  return out;
}
