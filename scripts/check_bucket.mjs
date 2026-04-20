import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync("worker/.env", "utf8").split("\n").reduce((a,l)=>{const[k,...v]=l.split("=");if(k&&v.length)a[k.trim()]=v.join("=").trim();return a;},{});
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PROJ = "93eeaff9-9efa-4b75-a51f-c0f29b1fa19f";
const FILE = "b1ec1ced-3ee0-41c9-b52b-42f4afb99e86.png";

console.log("=== 1. Bucket public status ===");
const { data: bucketList, error: be } = await supabase.storage.listBuckets();
if (bucketList) {
  const sb = bucketList.find(b=>b.id==="scene-images");
  console.log("scene-images bucket:", sb ? JSON.stringify({public:sb.public,id:sb.id,created:sb.created_at},null,2) : "NOT FOUND");
}

console.log("\n=== 2. Files actually under scene-images/<project_id>/ ===");
const { data: files, error: le } = await supabase.storage.from("scene-images").list(PROJ, {limit:100});
if (le) console.log("Error:", le);
else if (!files || !files.length) console.log(`NO files at scene-images/${PROJ}/`);
else {
  console.log(`Found ${files.length} files:`);
  files.slice(0,5).forEach(f=>console.log(`  - ${f.name} (${f.metadata?.size ?? "?"} bytes)`));
  const target = files.find(f=>f.name===FILE);
  console.log(`\nTarget ${FILE}: ${target ? "EXISTS ("+target.metadata?.size+" bytes)" : "MISSING"}`);
}

console.log("\n=== 3. Try public URL fetch ===");
const pubUrl = `${env.SUPABASE_URL}/storage/v1/object/public/scene-images/${PROJ}/${FILE}`;
const r1 = await fetch(pubUrl);
console.log(`Public URL: ${r1.status} ${r1.statusText}`);

console.log("\n=== 4. Try signed URL fetch ===");
const { data: sd, error: se } = await supabase.storage.from("scene-images").createSignedUrl(`${PROJ}/${FILE}`, 60);
if (se) console.log("Sign error:", se);
else if (sd?.signedUrl) {
  const r2 = await fetch(sd.signedUrl);
  console.log(`Signed URL: ${r2.status} ${r2.statusText}`);
}
