// Diagnose why scene-images for generation 93eeaff9 cannot be downloaded.
// Checks: generation row, scenes JSONB, storage listing, actual file existence.
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

const GEN_ID = "93eeaff9-9efa-4b75-a51f-c0f29b1fa19f";

console.log("=== 1. Find generation row ===");
const { data: gen, error: genErr } = await supabase
  .from("generations")
  .select("id, user_id, project_id, status, created_at, scenes")
  .eq("id", GEN_ID)
  .maybeSingle();
if (genErr) console.log("Error:", genErr);
else if (!gen) console.log("Generation NOT FOUND");
else {
  console.log(`Status: ${gen.status}, Project: ${gen.project_id}`);
  console.log(`User: ${gen.user_id}, Created: ${gen.created_at}`);
  const scenes = gen.scenes || [];
  console.log(`Scene count: ${Array.isArray(scenes) ? scenes.length : "not array"}`);
  if (Array.isArray(scenes) && scenes.length > 0) {
    console.log("\nFirst scene image URLs:");
    scenes.slice(0, 3).forEach((s, i) => {
      console.log(`  [${i}] imageUrl: ${s.imageUrl || s.image_url || "MISSING"}`);
      console.log(`      id: ${s.id || s.sceneId || "?"}`);
    });
  }
}

console.log("\n=== 2. List files actually in scene-images/93eeaff9... ===");
const { data: files, error: listErr } = await supabase.storage
  .from("scene-images")
  .list(GEN_ID, { limit: 100 });
if (listErr) console.log("Error:", listErr);
else if (!files || files.length === 0) console.log(`NO FILES found under scene-images/${GEN_ID}/`);
else {
  console.log(`Found ${files.length} files:`);
  files.slice(0, 10).forEach(f => console.log(`  - ${f.name} (${f.metadata?.size ?? "?"} bytes)`));
}

console.log("\n=== 3. Check video_generation_jobs ===");
const { data: jobs } = await supabase
  .from("video_generation_jobs")
  .select("id, type, status, payload, error_message, created_at, updated_at")
  .or(`payload->>generationId.eq.${GEN_ID},payload->>projectId.eq.${GEN_ID}`)
  .order("created_at", { ascending: false })
  .limit(10);
if (!jobs || jobs.length === 0) console.log("No jobs found");
else {
  console.log(`Found ${jobs.length} jobs:`);
  jobs.forEach(j => {
    console.log(`  ${j.type} [${j.status}] ${j.updated_at}`);
    if (j.error_message) console.log(`    ERROR: ${j.error_message}`);
  });
}

console.log("\n=== 4. Check project_id on generation for actual project ===");
if (gen?.project_id) {
  const { data: proj } = await supabase
    .from("projects")
    .select("id, status, project_type, updated_at")
    .eq("id", gen.project_id)
    .maybeSingle();
  console.log(proj ? JSON.stringify(proj, null, 2) : "project not found");

  console.log(`\n=== 5. List by project_id path instead ===`);
  const { data: projFiles } = await supabase.storage
    .from("scene-images")
    .list(gen.project_id, { limit: 100 });
  if (!projFiles || projFiles.length === 0) {
    console.log(`NO files under scene-images/${gen.project_id}/`);
  } else {
    console.log(`Found ${projFiles.length} files under scene-images/${gen.project_id}/`);
    projFiles.slice(0, 5).forEach(f => console.log(`  - ${f.name}`));
  }
}
