/**
 * migrate-storage-from-db.mjs
 * Extracts ALL storage file paths referenced in the database,
 * downloads from the OLD project, uploads to the NEW project.
 */

import { createClient } from "@supabase/supabase-js";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const SOURCE_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhlc25jZW96YmVkenJndnlscXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxNTUyOTIsImV4cCI6MjA4MzczMTI5Mn0.YU881FNTJeR_FAbOV3bTGBmUvYbbQfAX5KaHI6uq--U";

const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
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

function extractStoragePaths(url) {
  if (!url) return null;
  // Match patterns like /storage/v1/object/public/bucket-name/path
  // or /storage/v1/object/sign/bucket-name/path?token=...
  const publicMatch = url.match(
    /\/storage\/v1\/object\/public\/([^/]+)\/(.+?)(?:\?|$)/
  );
  if (publicMatch) {
    return { bucket: publicMatch[1], path: publicMatch[2], type: "public" };
  }
  const signMatch = url.match(
    /\/storage\/v1\/object\/sign\/([^/]+)\/(.+?)(?:\?|$)/
  );
  if (signMatch) {
    return { bucket: signMatch[1], path: signMatch[2], type: "signed" };
  }
  return null;
}

async function copyFile(bucket, path) {
  // Try public URL first (works for public buckets)
  const publicUrl = `${SOURCE_URL}/storage/v1/object/public/${bucket}/${path}`;
  let res = await fetch(publicUrl);

  if (!res.ok) {
    // Try signed URL approach - won't work without source service key
    return false;
  }

  const blob = await res.blob();
  if (blob.size === 0) return false;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await tgt.storage.from(bucket).upload(path, bytes, {
    contentType: blob.type || "application/octet-stream",
    upsert: true,
  });

  if (error) {
    // Ignore "already exists" errors
    if (error.message?.includes("already exists")) return true;
    return false;
  }
  return true;
}

async function main() {
  console.log("\n=== Storage Migration (from DB references) ===\n");

  // 1. Get all unique URLs from generations.scenes JSONB
  console.log("Extracting URLs from database...");

  const scenesResult = await dbQuery(`
    SELECT DISTINCT unnest(
      ARRAY(
        SELECT jsonb_array_elements(scenes)->>'imageUrl'
        FROM generations WHERE scenes IS NOT NULL
        UNION ALL
        SELECT jsonb_array_elements(scenes)->>'image_url'
        FROM generations WHERE scenes IS NOT NULL
        UNION ALL
        SELECT jsonb_array_elements(
          jsonb_array_elements(scenes)->'imageUrls'
        )::text
        FROM generations
        WHERE scenes IS NOT NULL
        AND jsonb_typeof(jsonb_array_elements(scenes)->'imageUrls') = 'array'
      )
    ) AS url
  `);

  const thumbnailResult = await dbQuery(`
    SELECT DISTINCT thumbnail_url AS url FROM projects WHERE thumbnail_url IS NOT NULL
  `);

  const audioResult = await dbQuery(`
    SELECT DISTINCT audio_url AS url FROM generations WHERE audio_url IS NOT NULL
  `);

  const videoResult = await dbQuery(`
    SELECT DISTINCT video_url AS url FROM generations WHERE video_url IS NOT NULL
  `);

  const voiceResult = await dbQuery(`
    SELECT DISTINCT sample_url AS url FROM user_voices WHERE sample_url IS NOT NULL
  `);

  // Combine all URLs
  const allUrls = new Set();
  for (const result of [scenesResult, thumbnailResult, audioResult, videoResult, voiceResult]) {
    if (Array.isArray(result)) {
      for (const row of result) {
        if (row.url) allUrls.add(row.url.replace(/^"|"$/g, ""));
      }
    }
  }

  console.log(`Found ${allUrls.size} unique storage URLs`);

  // Parse into bucket/path pairs
  const files = new Map(); // bucket/path -> type
  for (const url of allUrls) {
    const parsed = extractStoragePaths(url);
    if (parsed) {
      const key = `${parsed.bucket}/${parsed.path}`;
      if (!files.has(key)) {
        files.set(key, parsed);
      }
    }
  }

  console.log(`Parsed ${files.size} unique storage files to migrate\n`);

  // Group by bucket for stats
  const bucketStats = {};
  for (const [, info] of files) {
    bucketStats[info.bucket] = (bucketStats[info.bucket] || 0) + 1;
  }
  for (const [bucket, count] of Object.entries(bucketStats)) {
    console.log(`  ${bucket}: ${count} files`);
  }

  // 2. Copy files
  console.log("\nCopying files...");
  let ok = 0;
  let fail = 0;
  let skip = 0;
  let i = 0;

  for (const [, info] of files) {
    i++;
    const success = await copyFile(info.bucket, info.path);
    if (success) ok++;
    else fail++;

    if (i % 5 === 0) {
      process.stdout.write(
        `\r  ${i}/${files.size} (${ok} ok, ${fail} failed)`
      );
    }
    await sleep(100);
  }

  console.log(
    `\r  ${files.size}/${files.size} — ${ok} copied, ${fail} failed, ${skip} skipped`
  );
  console.log("\n✅ Storage migration complete!");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
