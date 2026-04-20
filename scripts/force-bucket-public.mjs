// Force-update scene-images bucket to public via Supabase Storage Admin API.
// SQL UPDATE on storage.buckets alone does not always invalidate the Storage
// service's in-memory cache; the REST admin endpoint is authoritative.
import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const env = fs.readFileSync("worker/.env", "utf8")
  .split("\n")
  .reduce((acc, line) => {
    const [k, ...v] = line.split("=");
    if (k && v.length) acc[k.trim()] = v.join("=").trim();
    return acc;
  }, {});

const url = env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key);

console.log("--- BEFORE ---");
const before = await supabase.storage.getBucket("scene-images");
console.log(JSON.stringify(before, null, 2));

console.log("\n--- UPDATING via Storage Admin API ---");
const update = await supabase.storage.updateBucket("scene-images", {
  public: true,
  fileSizeLimit: 10485760, // 10 MB
  allowedMimeTypes: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
});
console.log(JSON.stringify(update, null, 2));

console.log("\n--- AFTER ---");
const after = await supabase.storage.getBucket("scene-images");
console.log(JSON.stringify(after, null, 2));

console.log("\n--- TEST URL ---");
const testUrl = `${url}/storage/v1/object/public/scene-images/93eeaff9-9efa-4b75-a51f-c0f29b1fa19f/b1ec1ced-3ee0-41c9-b52b-42f4afb99e86.png`;
const resp = await fetch(testUrl);
console.log(`HTTP ${resp.status} ${resp.statusText}`);

console.log("\n--- TEST SIGNED URL ---");
const { data: signed, error: signErr } = await supabase.storage
  .from("scene-images")
  .createSignedUrl("93eeaff9-9efa-4b75-a51f-c0f29b1fa19f/b1ec1ced-3ee0-41c9-b52b-42f4afb99e86.png", 3600);
if (signErr) console.log("Sign error:", signErr);
else {
  const r = await fetch(signed.signedUrl);
  console.log(`Signed URL HTTP ${r.status} ${r.statusText}`);
  console.log(`Signed URL: ${signed.signedUrl.substring(0, 120)}...`);
}
