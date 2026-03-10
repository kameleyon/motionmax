/**
 * fix-storage-urls.mjs
 * Rewrites ALL storage URLs in the database from the old project
 * (hesnceozbedzrgvylqrm) to the new project (ayjbvcikuwknqdrpsdmj).
 * Handles both plain columns and JSONB scenes arrays.
 */

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";
const DB_API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;
const OLD_REF = "hesnceozbedzrgvylqrm";
const NEW_REF = "ayjbvcikuwknqdrpsdmj";

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

async function main() {
  console.log("=== Fix Storage URLs (old → new project ref) ===\n");

  // 1. Fix projects.thumbnail_url
  console.log("1. Fixing projects.thumbnail_url...");
  const r1 = await dbQuery(`
    UPDATE projects
    SET thumbnail_url = replace(thumbnail_url, '${OLD_REF}', '${NEW_REF}')
    WHERE thumbnail_url LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r1));

  // 2. Fix generations.audio_url
  console.log("2. Fixing generations.audio_url...");
  const r2 = await dbQuery(`
    UPDATE generations
    SET audio_url = replace(audio_url, '${OLD_REF}', '${NEW_REF}')
    WHERE audio_url LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r2));

  // 3. Fix generations.video_url
  console.log("3. Fixing generations.video_url...");
  const r3 = await dbQuery(`
    UPDATE generations
    SET video_url = replace(video_url, '${OLD_REF}', '${NEW_REF}')
    WHERE video_url LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r3));

  // 4. Fix generations.style_reference_url
  console.log("4. Fixing generations.style_reference_url...");
  const r4 = await dbQuery(`
    UPDATE generations
    SET style_reference_url = replace(style_reference_url, '${OLD_REF}', '${NEW_REF}')
    WHERE style_reference_url IS NOT NULL AND style_reference_url LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r4));

  // 5. Fix user_voices.sample_url
  console.log("5. Fixing user_voices.sample_url...");
  const r5 = await dbQuery(`
    UPDATE user_voices
    SET sample_url = replace(sample_url, '${OLD_REF}', '${NEW_REF}')
    WHERE sample_url LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r5));

  // 6. Fix JSONB scenes — replace old ref in the entire scenes JSON text
  console.log("6. Fixing generations.scenes JSONB (all URL fields)...");
  const r6 = await dbQuery(`
    UPDATE generations
    SET scenes = replace(scenes::text, '${OLD_REF}', '${NEW_REF}')::jsonb
    WHERE scenes IS NOT NULL
      AND scenes::text LIKE '%${OLD_REF}%'
  `);
  console.log("   Result:", JSON.stringify(r6));

  // 7. Verify — count remaining old refs
  console.log("\n7. Verifying no old URLs remain...");

  const check1 = await dbQuery(`
    SELECT 'projects.thumbnail_url' AS col, count(*) AS cnt
    FROM projects WHERE thumbnail_url LIKE '%${OLD_REF}%'
  `);
  const check2 = await dbQuery(`
    SELECT 'generations.audio_url' AS col, count(*) AS cnt
    FROM generations WHERE audio_url LIKE '%${OLD_REF}%'
  `);
  const check3 = await dbQuery(`
    SELECT 'generations.video_url' AS col, count(*) AS cnt
    FROM generations WHERE video_url LIKE '%${OLD_REF}%'
  `);
  const check4 = await dbQuery(`
    SELECT 'generations.scenes' AS col, count(*) AS cnt
    FROM generations WHERE scenes::text LIKE '%${OLD_REF}%'
  `);
  const check5 = await dbQuery(`
    SELECT 'user_voices.sample_url' AS col, count(*) AS cnt
    FROM user_voices WHERE sample_url LIKE '%${OLD_REF}%'
  `);

  const checks = [check1, check2, check3, check4, check5];
  let allClear = true;
  for (const c of checks) {
    if (Array.isArray(c) && c[0]) {
      const cnt = parseInt(c[0].cnt, 10);
      console.log(`   ${c[0].col}: ${cnt} remaining`);
      if (cnt > 0) allClear = false;
    }
  }

  if (allClear) {
    console.log("\n✅ All storage URLs updated successfully!");
  } else {
    console.log("\n⚠️  Some URLs still reference the old project.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
