/**
 * import-single-generation.mjs
 * Imports storage files for a specific generation from the old project.
 * Copies any files referenced in the generation's scenes that are missing from the new project.
 */

import { createClient } from "@supabase/supabase-js";

const GEN_ID = "75b556e2-d479-4fde-a4b4-aed52e1b84cc";
const USER_ID = "ce695137-9517-409d-bfc1-d51ad61db1db";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";
const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = "sbp_ebe4d4d2a85f31024d09a5bee0ef4076b18a6c45";

const tgt = createClient(TARGET_URL, TARGET_SVC);

async function dbQuery(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

function extractUrls(obj) {
  const urls = new Set();
  if (!obj) return urls;
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  const matches = str.matchAll(/https:\/\/hesnceozbedzrgvylqrm\.supabase\.co\/storage\/v1\/object\/(public|sign)\/([^/"?]+)\/([^"?]+)(?:\?[^"]*)?/g);
  for (const m of matches) {
    urls.add({ type: m[1], bucket: m[2], path: m[3] });
  }
  return urls;
}

async function copyFile(bucket, path) {
  const publicUrl = `${SOURCE_URL}/storage/v1/object/public/${bucket}/${path}`;
  let res;
  try {
    res = await fetch(publicUrl);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const blob = await res.blob();
  if (blob.size === 0) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const { error } = await tgt.storage.from(bucket).upload(path, bytes, {
    contentType: blob.type || "application/octet-stream",
    upsert: true,
  });
  if (error && !error.message?.includes("already exists")) {
    return { ok: false, reason: error.message };
  }
  return { ok: true, size: blob.size };
}

// 1. Get the generation's data
console.log(`Fetching generation ${GEN_ID}...`);
const genData = await dbQuery(`SELECT scenes, audio_url, video_url FROM generations WHERE id = '${GEN_ID}'`);
if (!genData.length || genData.message) {
  console.error("Generation not found or error:", genData);
  process.exit(1);
}

const gen = genData[0];
console.log("Generation found. Extracting URLs...\n");

// Collect all old-project URLs from the generation
const allUrls = new Set();
if (gen.scenes) {
  const scenes = typeof gen.scenes === "string" ? JSON.parse(gen.scenes) : gen.scenes;
  for (const scene of (Array.isArray(scenes) ? scenes : [])) {
    for (const key of ["imageUrl", "audioUrl", "videoUrl"]) {
      if (scene[key] && scene[key].includes("hesnceozbedzrgvylqrm")) {
        const m = scene[key].match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/);
        if (m) allUrls.add(JSON.stringify({ bucket: m[1], path: m[2] }));
      }
    }
    for (const url of (scene.imageUrls || [])) {
      if (url && url.includes("hesnceozbedzrgvylqrm")) {
        const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/);
        if (m) allUrls.add(JSON.stringify({ bucket: m[1], path: m[2] }));
      }
    }
  }
}
for (const col of [gen.audio_url, gen.video_url]) {
  if (col && col.includes("hesnceozbedzrgvylqrm")) {
    const m = col.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?|$)/);
    if (m) allUrls.add(JSON.stringify({ bucket: m[1], path: m[2] }));
  }
}

console.log(`Found ${allUrls.size} unique files to import\n`);

// 2. Copy each file
let ok = 0;
let fail = 0;
for (const raw of allUrls) {
  const { bucket, path } = JSON.parse(raw);
  process.stdout.write(`  ${bucket}/${path.slice(0, 50)}... `);
  const result = await copyFile(bucket, path);
  if (result.ok) {
    ok++;
    console.log(`✓ (${Math.round((result.size || 0) / 1024)}KB)`);
  } else {
    fail++;
    console.log(`✗ ${result.reason}`);
  }
}

console.log(`\nDone: ${ok} copied, ${fail} failed\n`);

// 3. Update the generation URLs to point to new project
if (ok > 0) {
  console.log("Updating DB URLs to new project...");
  const updated = await dbQuery(`
    UPDATE generations 
    SET 
      scenes = replace(scenes::text, 'hesnceozbedzrgvylqrm', '${TARGET_REF}')::jsonb,
      audio_url = replace(audio_url, 'hesnceozbedzrgvylqrm', '${TARGET_REF}'),
      video_url = replace(video_url, 'hesnceozbedzrgvylqrm', '${TARGET_REF}')
    WHERE id = '${GEN_ID}'
  `);
  console.log("URL update result:", JSON.stringify(updated));
  console.log("✅ Generation imported and URLs updated!");
}
