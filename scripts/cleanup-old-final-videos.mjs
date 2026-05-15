#!/usr/bin/env node
// Composite-policy cleanup for the `videos/` final-export bucket:
//
//   Delete a file iff:
//     (1) the file itself is older than 30 days, AND
//     (2) the project it belongs to has updated_at older than 30 days
//
// Orphans (file references a generation or project that no longer
// exists in the DB) are deleted unconditionally — those are already
// stranded with no possible legitimate access path.
//
// Why both gates:
//   - Just age-of-file would nuke a 90-day-old export from a user who
//     opened the project last week (active re-edit workflow).
//   - Just age-of-project would nuke a freshly-rendered export the
//     user is about to download from a long-idle project.
//   - Both gates together = "abandoned project's old exports", which
//     is the cohort least likely to be needed.
//
// Usage:
//   node scripts/cleanup-old-final-videos.mjs              # dry-run
//   node scripts/cleanup-old-final-videos.mjs --execute    # delete
//   node scripts/cleanup-old-final-videos.mjs --days 60    # use 60d cutoff
import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("Missing SUPABASE_URL/SERVICE_ROLE_KEY"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const daysIdx = argv.indexOf("--days");
const days = daysIdx >= 0 ? Number(argv[daysIdx + 1]) : 30;
const PAGE = 1000;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

console.log(`▶ mode = ${execute ? "EXECUTE" : "DRY-RUN"}`);
console.log(`▶ policy = file age > ${days}d AND project untouched > ${days}d`);
console.log(`▶ cutoff = ${new Date(cutoffMs).toISOString()}\n`);

// 1. Build live-project map: project_id → updated_at (ms epoch).
console.log("Loading projects…");
const projectsMap = new Map();
{
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("projects").select("id, updated_at").range(from, from + PAGE - 1);
    if (error) { console.error("projects:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const r of data) projectsMap.set(r.id, new Date(r.updated_at).getTime());
    if (data.length < PAGE) break;
    from += PAGE;
  }
}
console.log(`  ${projectsMap.size} projects loaded.`);

// 2. Build generation_id → project_id map.
console.log("Loading generations…");
const genToProject = new Map();
{
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from("generations").select("id, project_id").range(from, from + PAGE - 1);
    if (error) { console.error("generations:", error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    for (const r of data) genToProject.set(r.id, r.project_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
}
console.log(`  ${genToProject.size} generations loaded.\n`);

// 3. Walk videos/ recursively, classify each file.
const stats = {
  totalFiles: 0,
  totalBytes: 0,
  toDelete: 0,
  toDeleteBytes: 0,
  keepRecentFile: 0,
  keepRecentProject: 0,
  unattributable: 0,
  unattributableBytes: 0,
  orphanGen: 0,
  orphanGenBytes: 0,
  orphanProj: 0,
  orphanProjBytes: 0,
};
const deletePaths = [];

async function walk(prefix) {
  let off = 0;
  for (;;) {
    const { data, error } = await sb.storage.from("videos").list(prefix, {
      limit: PAGE, offset: off, sortBy: { column: "name", order: "asc" },
    });
    if (error) { console.error(`list videos/${prefix}: ${error.message}`); return; }
    if (!data || data.length === 0) break;
    for (const e of data) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null && (e.metadata === null || e.metadata === undefined)) {
        await walk(path);
      } else {
        classifyFile(path, e);
      }
    }
    if (data.length < PAGE) break;
    off += PAGE;
  }
}

function classifyFile(path, entry) {
  stats.totalFiles++;
  const bytes = entry.metadata?.size ?? 0;
  stats.totalBytes += bytes;

  const fileAgeMs = Date.now() - new Date(entry.updated_at ?? entry.created_at ?? Date.now()).getTime();
  const fileOldEnough = fileAgeMs > days * 24 * 60 * 60 * 1000;

  // Find a UUID in the path that resolves to a known generation_id.
  const uuids = (path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);
  let projectId = null;
  let hadGenMatch = false;
  for (const u of uuids) {
    if (genToProject.has(u)) {
      projectId = genToProject.get(u);
      hadGenMatch = true;
      break;
    }
    if (projectsMap.has(u)) {
      // Older flat layout might key by project directly.
      projectId = u;
      break;
    }
  }

  if (!projectId) {
    // We can't tell which project owns this file. Two sub-cases:
    //   (a) UUIDs in path map to neither a live generation nor a live
    //       project → orphan (parent was deleted) → safe to delete.
    //   (b) No UUID in path at all → flat layout legacy file. Don't
    //       delete blindly; surface for manual review.
    if (uuids.length > 0) {
      // Orphan path
      if (hadGenMatch) { stats.orphanGen++; stats.orphanGenBytes += bytes; }
      else { stats.orphanProj++; stats.orphanProjBytes += bytes; }
      stats.toDelete++; stats.toDeleteBytes += bytes;
      deletePaths.push(path);
    } else {
      stats.unattributable++;
      stats.unattributableBytes += bytes;
    }
    return;
  }

  const projectUpdatedAt = projectsMap.get(projectId);
  if (projectUpdatedAt === undefined) {
    // Generation exists but its parent project was deleted — orphan.
    stats.orphanProj++; stats.orphanProjBytes += bytes;
    stats.toDelete++; stats.toDeleteBytes += bytes;
    deletePaths.push(path);
    return;
  }

  const projectIdleEnough = (Date.now() - projectUpdatedAt) > days * 24 * 60 * 60 * 1000;

  if (!fileOldEnough) { stats.keepRecentFile++; return; }
  if (!projectIdleEnough) { stats.keepRecentProject++; return; }

  // Both gates pass → delete.
  stats.toDelete++; stats.toDeleteBytes += bytes;
  deletePaths.push(path);
}

console.log("Walking videos/ bucket…");
await walk("");
console.log(`  ${stats.totalFiles} files / ${(stats.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB total\n`);

console.log("━━━ classification ━━━");
console.log(`  Keep (file <${days}d old):           ${stats.keepRecentFile}`);
console.log(`  Keep (project touched <${days}d):    ${stats.keepRecentProject}`);
console.log(`  Unattributable (no UUID in path):    ${stats.unattributable} / ${(stats.unattributableBytes / 1024 / 1024 / 1024).toFixed(2)} GB  ← review manually`);
console.log(`  Orphan (generation deleted):         ${stats.orphanGen} / ${(stats.orphanGenBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(`  Orphan (project deleted):            ${stats.orphanProj} / ${(stats.orphanProjBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(`  Marked for deletion:                 ${stats.toDelete} / ${(stats.toDeleteBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

if (execute && deletePaths.length > 0) {
  console.log("\nDeleting…");
  for (let i = 0; i < deletePaths.length; i += 1000) {
    const batch = deletePaths.slice(i, i + 1000);
    const { error } = await sb.storage.from("videos").remove(batch);
    if (error) console.error(`  batch ${i / 1000}: ${error.message}`);
    else console.log(`  batch ${i / 1000}: ${batch.length} files removed`);
  }
}
if (!execute) console.log(`\n(re-run with --execute to delete)`);
