const TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const URL = "https://api.supabase.com/v1/projects/ayjbvcikuwknqdrpsdmj/database/query";

async function q(query) {
  const r = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  return r.json();
}

// Get the actual URL format from scenes
const rows = await q(`
  SELECT id, scenes::text AS s
  FROM generations
  WHERE scenes IS NOT NULL
    AND scenes::text LIKE '%imageUrl%'
    AND scenes::text != 'null'
  LIMIT 3
`);

for (const row of rows) {
  const scenes = JSON.parse(row.s);
  for (const scene of scenes.slice(0, 1)) {
    if (scene.imageUrl) console.log("imageUrl:", scene.imageUrl);
    if (scene.audioUrl) console.log("audioUrl:", scene.audioUrl);
    if (scene.imageUrls) console.log("imageUrls[0]:", scene.imageUrls[0]);
  }
}

// Also check how many scenes still reference old project
const oldCheck = await q(`
  SELECT count(*) as cnt FROM generations WHERE scenes::text LIKE '%hesnceozbedzrgvylqrm%'
`);
console.log("\nScenes still referencing OLD project:", oldCheck[0]?.cnt ?? "0");

const newCheck = await q(`
  SELECT count(*) as cnt FROM generations WHERE scenes::text LIKE '%ayjbvcikuwknqdrpsdmj%'
`);
console.log("Scenes referencing NEW project:", newCheck[0]?.cnt ?? "0");

// Check if the URL actually resolves
const urlCheck = await q(`
  SELECT jsonb_array_elements(scenes)->>'imageUrl' AS url
  FROM generations 
  WHERE scenes IS NOT NULL 
    AND jsonb_typeof(scenes) = 'array'
    AND scenes::text LIKE '%imageUrl%'
  LIMIT 1
`);
if (urlCheck.length > 0 && urlCheck[0].url) {
  const testUrl = urlCheck[0].url;
  console.log("\nTest URL:", testUrl);
  try {
    const res = await fetch(testUrl, { method: "HEAD" });
    console.log("HTTP status:", res.status, res.statusText);
  } catch (e) {
    console.log("Fetch error:", e.message);
  }
}
