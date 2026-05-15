#!/usr/bin/env node
// Total storage by bucket, plus intermediate-asset size for LIVE
// completed projects (the assets that the current 30-day policy
// keeps but the user almost certainly doesn't need anymore once
// their final video exists). Read-only.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const ALL_BUCKETS = ["scene-images", "audio", "scene-videos", "videos"];
const PAGE = 1000;

async function walk(bucket, prefix) {
  let bytes = 0, files = 0;
  let pageIdx = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, {
      limit: PAGE, offset: pageIdx * PAGE, sortBy: { column: "name", order: "asc" },
    });
    if (error) { console.error(`list ${bucket}/${prefix}: ${error.message}`); return { bytes, files }; }
    if (!data || data.length === 0) break;
    for (const e of data) {
      // If this is a folder entry (metadata=null, id=null), recurse.
      if (e.id === null && (e.metadata === null || e.metadata === undefined)) {
        const sub = await walk(bucket, prefix ? `${prefix}/${e.name}` : e.name);
        bytes += sub.bytes; files += sub.files;
      } else {
        bytes += e.metadata?.size ?? 0;
        files += 1;
      }
    }
    if (data.length < PAGE) break;
    pageIdx++;
  }
  return { bytes, files };
}

console.log(`▶ Sizing all buckets (this may take 30-60s)\n`);
let grandBytes = 0, grandFiles = 0;
const perBucket = {};
for (const b of ALL_BUCKETS) {
  process.stdout.write(`  scanning ${b}…`);
  const { bytes, files } = await walk(b, "");
  perBucket[b] = { bytes, files };
  grandBytes += bytes; grandFiles += files;
  process.stdout.write(` ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${files} files\n`);
}
console.log(`\n  TOTAL: ${(grandBytes / 1024 / 1024 / 1024).toFixed(2)} GB / ${grandFiles} files\n`);

// Now: for LIVE projects with a final video_url set, size their
// intermediate footprint. These are projects the user has already
// exported — the intermediates have no further use.
console.log(`▶ Sizing intermediates for LIVE projects with a final video_url\n`);
const { data: completedProjects, error } = await sb
  .from("projects")
  .select("id, updated_at, video_url")
  .not("video_url", "is", null);
if (error) {
  console.error("projects query:", error.message);
  process.exit(1);
}
console.log(`  ${completedProjects.length} projects have a final video.\n`);

let interBytes = 0, interFiles = 0;
const buckets = ["scene-images", "audio", "scene-videos"];
let i = 0;
for (const p of completedProjects) {
  let pBytes = 0;
  for (const b of buckets) {
    const { bytes, files } = await walk(b, p.id);
    pBytes += bytes;
    interFiles += files;
  }
  interBytes += pBytes;
  i++;
  if (i % 50 === 0 || i === completedProjects.length) {
    console.log(`  [${i}/${completedProjects.length}] running total: ${(interBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  }
}
console.log(`\n  Total intermediate footprint for exported projects:`);
console.log(`     ${(interBytes / 1024 / 1024 / 1024).toFixed(2)} GB across ${interFiles} files`);
console.log(`     (would be freed by an "intermediates of completed projects" purge,`);
console.log(`      ignoring the 30-day age gate)`);
