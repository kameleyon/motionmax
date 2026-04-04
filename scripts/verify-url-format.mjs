const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const API = "https://api.supabase.com/v1/projects/ayjbvcikuwknqdrpsdmj/database/query";

async function q(query) {
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

// Check what the raw scenes text looks like for a generation with images
const raw = await q(`
  SELECT id, substring(scenes::text, 1, 600) AS raw_text
  FROM generations
  WHERE scenes IS NOT NULL AND scenes::text LIKE '%imageUrl%'
  LIMIT 1
`);

if (raw.length > 0) {
  console.log("Raw scenes text preview:");
  console.log(raw[0].raw_text);
  console.log("\nContains '/sign/audio/':", raw[0].raw_text.includes("/sign/audio/"));
  console.log("Contains '\\/sign\\/audio\\/':", raw[0].raw_text.includes("\\/sign\\/audio\\/"));
}

// Check total scenes with /sign/ vs /public/ for audio URLs
const counts = await q(`
  SELECT
    count(*) FILTER (WHERE scenes::text LIKE '%\\/sign\\/audio\\/%') AS json_escaped_signed,
    count(*) FILTER (WHERE scenes::text LIKE '%/sign/audio/%') AS url_slash_signed,
    count(*) FILTER (WHERE scenes::text LIKE '%/public/audio/%') AS public_urls,
    count(*) AS total_with_scenes
  FROM generations
  WHERE scenes IS NOT NULL AND scenes::text LIKE '%imageUrl%'
`);
console.log("\nURL counts:", JSON.stringify(counts[0]));
