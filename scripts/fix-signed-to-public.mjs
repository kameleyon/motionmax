/**
 * fix-signed-to-public.mjs
 * The audio bucket is now public on the target project.
 * Old signed URL tokens (signed by the old project's key) are invalid here.
 * Convert ALL /sign/audio/ URLs → /public/audio/ (strip ?token=...) across:
 *   - generations.scenes JSONB (imageUrl, imageUrls, audioUrl)
 *   - generations.audio_url
 *   - projects.thumbnail_url
 */

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const DB_API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;

async function q(query) {
  const r = await fetch(DB_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const t = await r.json();
  if (t.message) console.error("SQL error:", t.message);
  return t;
}

console.log("Converting signed audio URLs → public URLs in DB...\n");

// 1. Fix scenes JSONB — replace /sign/audio/ with /public/audio/ and strip tokens
const r1 = await q(`
  UPDATE generations
  SET scenes = replace(
    regexp_replace(
      scenes::text,
      '/storage/v1/object/sign/audio/([^?\"]+)(\\?token=[^\"]*)',
      '/storage/v1/object/public/audio/\\1',
      'g'
    ),
    '',
    ''
  )::jsonb
  WHERE scenes IS NOT NULL
    AND scenes::text LIKE '%/sign/audio/%'
`);
console.log("1. scenes JSONB fixed:", JSON.stringify(r1));

// 2. Fix generations.audio_url
const r2 = await q(`
  UPDATE generations
  SET audio_url = regexp_replace(
    audio_url,
    '/storage/v1/object/sign/audio/([^?]+)(\\?token=[^ ]*)?$',
    '/storage/v1/object/public/audio/\\1'
  )
  WHERE audio_url LIKE '%/sign/audio/%'
`);
console.log("2. audio_url fixed:", JSON.stringify(r2));

// 3. Fix projects.thumbnail_url
const r3 = await q(`
  UPDATE projects
  SET thumbnail_url = regexp_replace(
    thumbnail_url,
    '/storage/v1/object/sign/audio/([^?]+)(\\?token=[^ ]*)?$',
    '/storage/v1/object/public/audio/\\1'
  )
  WHERE thumbnail_url LIKE '%/sign/audio/%'
`);
console.log("3. thumbnail_url fixed:", JSON.stringify(r3));

// Verify no signed audio URLs remain
const check = await q(`
  SELECT 
    (SELECT count(*) FROM generations WHERE scenes::text LIKE '%/sign/audio/%') AS scenes_signed,
    (SELECT count(*) FROM generations WHERE audio_url LIKE '%/sign/audio/%') AS audio_signed
`);
console.log("\nVerification:", JSON.stringify(check));

// Test a converted URL actually loads
const test = await q(`
  SELECT jsonb_array_elements(scenes)->>'imageUrl' AS url
  FROM generations
  WHERE scenes IS NOT NULL AND scenes::text LIKE '%/public/audio/%'
  LIMIT 1
`);
if (test.length > 0 && test[0].url) {
  const url = test[0].url;
  console.log("\nTest public URL:", url);
  const res = await fetch(url, { method: "HEAD" });
  console.log("HTTP status:", res.status, res.statusText);
}

console.log("\n✅ Done!");
