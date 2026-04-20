// Figure out what 93eeaff9-9efa-4b75-a51f-c0f29b1fa19f actually is
// and where the scene images really live.
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
const ID = "93eeaff9-9efa-4b75-a51f-c0f29b1fa19f";

console.log("=== Check if it's a project ===");
const { data: project } = await supabase
  .from("projects")
  .select("id, user_id, project_type, status, created_at")
  .eq("id", ID)
  .maybeSingle();
if (project) console.log("PROJECT FOUND:", JSON.stringify(project, null, 2));
else console.log("Not a project id");

console.log("\n=== List top-level folders in scene-images ===");
const { data: folders } = await supabase.storage
  .from("scene-images")
  .list("", { limit: 20, sortBy: { column: "created_at", order: "desc" } });
if (folders) {
  console.log(`Top ${folders.length} entries:`);
  folders.forEach(f => console.log(`  ${f.name} (created ${f.created_at})`));
}

console.log("\n=== Find the most recent generations ===");
const { data: recentGens } = await supabase
  .from("generations")
  .select("id, user_id, project_id, status, created_at, scenes")
  .order("created_at", { ascending: false })
  .limit(5);
if (recentGens) {
  recentGens.forEach(g => {
    console.log(`  gen ${g.id} [${g.status}] project=${g.project_id} scenes=${Array.isArray(g.scenes) ? g.scenes.length : "?"}`);
    if (Array.isArray(g.scenes) && g.scenes[0]) {
      const s = g.scenes[0];
      console.log(`    first imageUrl: ${s.imageUrl || s.image_url || "none"}`);
    }
  });
}

console.log("\n=== Recent projects ===");
const { data: recentProjects } = await supabase
  .from("projects")
  .select("id, user_id, project_type, status, created_at, scenes")
  .order("created_at", { ascending: false })
  .limit(5);
if (recentProjects) {
  recentProjects.forEach(p => {
    console.log(`  proj ${p.id} [${p.status}/${p.project_type}] ${p.created_at}`);
    if (Array.isArray(p.scenes) && p.scenes[0]) {
      const s = p.scenes[0];
      console.log(`    scenes=${p.scenes.length}, first imageUrl: ${(s.imageUrl || s.image_url || "none").substring(0, 120)}`);
    }
  });
}
