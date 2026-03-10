/**
 * migrate-audio-bucket.mjs
 * Migrates the private `audio` bucket (now made public on source)
 * and `voice_samples` bucket from the old project to the new project.
 * File paths are extracted from DB URLs rather than bucket listing.
 */

import { createClient } from "@supabase/supabase-js";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";
const DB_API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;

const tgt = createClient(TARGET_URL, TARGET_SVC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dbQuery(sql) {
  const r = await fetch(DB_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  return r.json();
}

function extractAudioPath(url) {
  if (!url) return null;
  // Match /public/audio/ or /sign/audio/ paths
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/audio\/(.+?)(?:\?|$)/);
  return m ? m[1] : null;
}

function extractVoicePath(url) {
  if (!url) return null;
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/voice_samples\/(.+?)(?:\?|$)/);
  return m ? m[1] : null;
}

async function copyFile(bucket, path) {
  const publicUrl = `${SOURCE_URL}/storage/v1/object/public/${bucket}/${path}`;
  let res;
  try {
    res = await fetch(publicUrl);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  if (!res.ok) {
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  const blob = await res.blob();
  if (blob.size === 0) {
    return { ok: false, reason: "empty blob" };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await tgt.storage.from(bucket).upload(path, bytes, {
    contentType: blob.type || "application/octet-stream",
    upsert: true,
  });

  if (error) {
    if (error.message?.includes("already exists")) return { ok: true, reason: "exists" };
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

async function collectPaths() {
  const paths = new Map(); // "bucket/path" => { bucket, path }

  // Audio paths from scenes JSONB — imageUrl
  const q1 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'imageUrl' AS url
    FROM generations WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);
  // Audio paths from scenes JSONB — audioUrl
  const q2 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'audioUrl' AS url
    FROM generations WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);
  // Multiple imageUrls per scene (array)
  const q3 = await dbQuery(`
    SELECT jsonb_array_elements(jsonb_array_elements(scenes)->'imageUrls')::text AS url
    FROM generations WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);
  // Generation-level audio_url
  const q4 = await dbQuery(`
    SELECT audio_url AS url FROM generations WHERE audio_url LIKE '%/audio/%'
  `);
  // voice_samples
  const q5 = await dbQuery(`
    SELECT sample_url AS url FROM user_voices WHERE sample_url IS NOT NULL
  `);

  for (const result of [q1, q2, q3, q4]) {
    if (!Array.isArray(result)) continue;
    for (const row of result) {
      const raw = (row.url || "").replace(/^"|"$/g, "");
      const p = extractAudioPath(raw);
      if (p) paths.set(`audio/${p}`, { bucket: "audio", path: p });
    }
  }
  if (Array.isArray(q5)) {
    for (const row of q5) {
      const raw = (row.url || "").replace(/^"|"$/g, "");
      const p = extractVoicePath(raw);
      if (p) paths.set(`voice_samples/${p}`, { bucket: "voice_samples", path: p });
    }
  }

  return paths;
}

async function main() {
  console.log("\n=== Audio + Voice Samples Bucket Migration ===\n");

  console.log("Collecting file paths from database...");
  const paths = await collectPaths();
  console.log(`Found ${paths.size} unique files to migrate\n`);

  // Group by bucket
  const byBucket = {};
  for (const { bucket } of paths.values()) {
    byBucket[bucket] = (byBucket[bucket] || 0) + 1;
  }
  for (const [b, cnt] of Object.entries(byBucket)) {
    console.log(`  ${b}: ${cnt} files`);
  }

  console.log("\nCopying files...\n");
  let ok = 0;
  let fail = 0;
  let i = 0;
  const failures = [];

  for (const { bucket, path } of paths.values()) {
    i++;
    const result = await copyFile(bucket, path);
    if (result.ok) {
      ok++;
    } else {
      fail++;
      if (failures.length < 20) failures.push(`${bucket}/${path} — ${result.reason}`);
    }

    if (i % 20 === 0) {
      process.stdout.write(`\r  ${i}/${paths.size} (${ok} ok, ${fail} failed)`);
    }
    await sleep(60);
  }

  console.log(`\n\n  Total: ${paths.size} | Copied: ${ok} | Failed: ${fail}\n`);

  if (failures.length > 0) {
    console.log("Sample failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }

  // Verify
  console.log("\nVerifying target storage...\n");
  const verify = await dbQuery(`
    SELECT bucket_id, count(*) as cnt FROM storage.objects
    GROUP BY bucket_id ORDER BY cnt DESC
  `);

  if (Array.isArray(verify)) {
    let total = 0;
    for (const row of verify) {
      console.log(`  ${row.bucket_id}: ${row.cnt}`);
      total += parseInt(row.cnt, 10);
    }
    console.log(`  TOTAL: ${total}`);
  }

  console.log("\n✅ Done!");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
