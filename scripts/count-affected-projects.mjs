// Count projects that have complete generations pointing at scene-images
// that no longer exist in storage (victims of premature cleanup).
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync("worker/.env", "utf8")
  .split("\n")
  .reduce((acc, line) => {
    const [k, ...v] = line.split("=");
    if (k && v.length) acc[k.trim()] = v.join("=").trim();
    return acc;
  }, {});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Find generations completed in the window when the buggy cleanup was live.
// Previous commit (007548f merge(wave2-worker)) introduced cleanupIntermediateAssets.
// That landed earlier today. Check the last 24h.
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const { data: gens } = await supabase
  .from("generations")
  .select("id, user_id, project_id, status, created_at, scenes")
  .eq("status", "complete")
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(100);

if (!gens) { console.log("no gens"); process.exit(0); }
console.log(`Found ${gens.length} completed generations in last 24h\n`);

const affected = [];
const healthy = [];
for (const g of gens) {
  if (!Array.isArray(g.scenes) || g.scenes.length === 0) continue;

  // Peek at the first scene's image path
  const firstScene = g.scenes[0];
  const url = firstScene.imageUrl || firstScene.image_url;
  if (!url) continue;

  const m = url.match(/\/scene-images\/([^/]+)\/(.+\.png)/);
  if (!m) continue;

  const [, projectId, filename] = m;

  // Check if the file exists in storage
  const { data, error } = await supabase.storage
    .from("scene-images")
    .createSignedUrl(`${projectId}/${filename}`, 60);

  if (error) affected.push({ gen: g.id, project: g.project_id, user: g.user_id, created: g.created_at });
  else healthy.push(g.id);
}

console.log(`\n=== AFFECTED (scene-images missing): ${affected.length} ===`);
const byUser = {};
for (const a of affected) {
  byUser[a.user] = (byUser[a.user] || []);
  byUser[a.user].push(a);
}
for (const [userId, gens] of Object.entries(byUser)) {
  console.log(`  User ${userId}: ${gens.length} affected generations`);
  gens.slice(0, 3).forEach(g => console.log(`    - gen ${g.gen} (project ${g.project}) at ${g.created}`));
}

console.log(`\n=== HEALTHY (scene-images still present): ${healthy.length} ===`);
