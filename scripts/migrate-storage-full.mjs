/**
 * migrate-storage-full.mjs
 * Comprehensive storage migration: discovers ALL storage URLs from the
 * TARGET database (which still reference the old SOURCE project), downloads
 * from the source via public URLs, and uploads to the target.
 */

import { createClient } from "@supabase/supabase-js";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";

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
  const publicUrl = `${SOURCE_URL}/storage/v1/object/public/${bucket}/${path}`;
  let res;
  try {
    res = await fetch(publicUrl);
  } catch {
    return false;
  }

  if (!res.ok) return false;

  const blob = await res.blob();
  if (blob.size === 0) return false;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await tgt.storage.from(bucket).upload(path, bytes, {
    contentType: blob.type || "application/octet-stream",
    upsert: true,
  });

  if (error) {
    if (error.message?.includes("already exists")) return true;
    return false;
  }
  return true;
}

async function main() {
  console.log("\n=== Full Storage Migration ===\n");
  console.log("Step 1: Extracting ALL storage URLs from database...\n");

  // Query 1: Scene imageUrl from JSONB
  const q1 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'imageUrl' AS url
    FROM generations
    WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);

  // Query 2: Scene image_url from JSONB
  const q2 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'image_url' AS url
    FROM generations
    WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);

  // Query 3: Scene audioUrl
  const q3 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'audioUrl' AS url
    FROM generations
    WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);

  // Query 4: Scene audio_url
  const q4 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'audio_url' AS url
    FROM generations
    WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);

  // Query 5: Scene videoUrl
  const q5 = await dbQuery(`
    SELECT jsonb_array_elements(scenes)->>'videoUrl' AS url
    FROM generations
    WHERE scenes IS NOT NULL AND jsonb_typeof(scenes) = 'array'
  `);

  // Query 6: Generation-level audio_url
  const q6 = await dbQuery(`
    SELECT audio_url AS url FROM generations WHERE audio_url IS NOT NULL
  `);

  // Query 7: Generation-level video_url
  const q7 = await dbQuery(`
    SELECT video_url AS url FROM generations WHERE video_url IS NOT NULL
  `);

  // Query 8: Project thumbnails
  const q8 = await dbQuery(`
    SELECT thumbnail_url AS url FROM projects WHERE thumbnail_url IS NOT NULL
  `);

  // Query 9: Voice samples
  const q9 = await dbQuery(`
    SELECT sample_url AS url FROM user_voices WHERE sample_url IS NOT NULL
  `);

  // Query 10: Style reference URLs from generations
  const q10 = await dbQuery(`
    SELECT style_reference_url AS url FROM generations WHERE style_reference_url IS NOT NULL
  `);

  // Combine all URLs
  const allUrls = new Set();
  const queries = [q1, q2, q3, q4, q5, q6, q7, q8, q9, q10];
  for (const result of queries) {
    if (Array.isArray(result)) {
      for (const row of result) {
        if (row.url) allUrls.add(row.url.replace(/^"|"$/g, ""));
      }
    }
  }

  console.log(`Found ${allUrls.size} unique storage URLs\n`);

  // Parse into bucket/path pairs
  const files = new Map();
  for (const url of allUrls) {
    const parsed = extractStoragePaths(url);
    if (parsed) {
      const key = `${parsed.bucket}/${parsed.path}`;
      if (!files.has(key)) {
        files.set(key, parsed);
      }
    }
  }

  console.log(`Parsed ${files.size} unique storage file paths\n`);

  // Group by bucket for stats
  const bucketStats = {};
  for (const [, info] of files) {
    bucketStats[info.bucket] = (bucketStats[info.bucket] || 0) + 1;
  }
  for (const [bucket, count] of Object.entries(bucketStats)) {
    console.log(`  ${bucket}: ${count} files`);
  }

  // Copy files
  console.log("\nStep 2: Copying files from source to target...\n");
  let ok = 0;
  let fail = 0;
  let i = 0;
  const failures = [];

  for (const [, info] of files) {
    i++;
    const success = await copyFile(info.bucket, info.path);
    if (success) {
      ok++;
    } else {
      fail++;
      failures.push(`${info.bucket}/${info.path}`);
    }

    if (i % 10 === 0) {
      process.stdout.write(
        `\r  ${i}/${files.size} (${ok} ok, ${fail} failed)`
      );
    }
    await sleep(80);
  }

  console.log(
    `\n\n  Total: ${files.size} | Copied: ${ok} | Failed: ${fail}\n`
  );

  if (failures.length > 0) {
    console.log("Failed files:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }

  // Verify
  console.log("\nStep 3: Verifying target storage...\n");
  const verify = await dbQuery(`
    SELECT bucket_id, count(*) as cnt
    FROM storage.objects
    GROUP BY bucket_id
    ORDER BY cnt DESC
  `);

  if (Array.isArray(verify)) {
    let total = 0;
    for (const row of verify) {
      console.log(`  ${row.bucket_id}: ${row.cnt} files`);
      total += parseInt(row.cnt, 10);
    }
    console.log(`  TOTAL: ${total} files`);
  }

  console.log("\n✅ Storage migration complete!");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
