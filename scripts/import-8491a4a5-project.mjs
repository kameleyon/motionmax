/**
 * Imports all audio/image files for project 8491a4a5 (urbanbrujetta4ever) from the old project.
 * Old project audio bucket is PUBLIC so direct URL downloads work.
 * Lists files via Supabase storage REST API, then copies to new project.
 */

import { createClient } from "@supabase/supabase-js";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const SOURCE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhlc25jZW96YmVkenJndnlscXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxNTUyOTIsImV4cCI6MjA4MzczMTI5Mn0.YU881FNTJeR_FAbOV3bTGBmUvYbbQfAX5KaHI6uq--U";

const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";

const USER_ID = "ce695137-9517-409d-bfc1-d51ad61db1db";
const PROJECT_UUID = "8491a4a5-1c29-4971-ac63-1c287b390a20";
const PATH_PREFIX = `${USER_ID}/${PROJECT_UUID}`;

const src = createClient(SOURCE_URL, SOURCE_ANON);
const tgt = createClient(TARGET_URL, TARGET_SVC);

// Step 1: List files via storage REST API (POST /object/list/audio)
console.log("Listing files via storage REST API...");
const listRes = await fetch(`${SOURCE_URL}/storage/v1/object/list/audio`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${SOURCE_ANON}`,
    apikey: SOURCE_ANON,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prefix: PATH_PREFIX, limit: 500, offset: 0 }),
});

const listed = listRes.ok ? await listRes.json() : [];
console.log(`REST listing returned ${Array.isArray(listed) ? listed.length : "error"}: ${listRes.status}`);
if (!listRes.ok) console.log("Response:", JSON.stringify(listed));

// Step 2: Also try Supabase JS client listing
const { data: jsListed, error: jsErr } = await src.storage.from("audio").list(PATH_PREFIX, { limit: 500 });
console.log(`JS listing returned ${jsListed?.length || 0} files (error: ${jsErr?.message || "none"})`);

// Combine file paths from both methods
const filePaths = new Set();
for (const item of (Array.isArray(listed) ? listed : [])) {
  if (item.name) filePaths.add(`${PATH_PREFIX}/${item.name}`);
}
for (const item of (jsListed || [])) {
  if (item.name && item.id) filePaths.add(`${PATH_PREFIX}/${item.name}`);
}

// Step 3: If listing failed, probe known filename patterns (fallback)
if (filePaths.size === 0) {
  console.log("\nListing returned 0 files. Probing expected file patterns...");
  const exts = ["png", "mp3", "wav"];
  const suffixes = ["", "-1", "-2", "-3", "-regenerated"];

  for (let scene = 1; scene <= 17; scene++) {
    for (const ext of exts) {
      for (const suffix of suffixes) {
        const name = `scene-${scene}${suffix}.${ext}`;
        const url = `${SOURCE_URL}/storage/v1/object/public/audio/${PATH_PREFIX}/${name}`;
        const probe = await fetch(url, { method: "HEAD" });
        if (probe.ok) {
          filePaths.add(`${PATH_PREFIX}/${name}`);
          process.stdout.write(".");
        }
      }
    }
  }
  console.log(`\nProbing found ${filePaths.size} files`);
}

console.log(`\nTotal files to copy: ${filePaths.size}`);
for (const f of filePaths) console.log("  ", f);

// Step 4: Copy each file to new project
let ok = 0;
let fail = 0;
for (const filePath of filePaths) {
  const url = `${SOURCE_URL}/storage/v1/object/public/audio/${filePath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) { fail++; continue; }
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { error } = await tgt.storage.from("audio").upload(filePath, bytes, {
      contentType: blob.type || "application/octet-stream",
      upsert: true,
    });
    if (error && !error.message?.includes("already exists")) {
      console.log(`  FAIL ${filePath}: ${error.message}`);
      fail++;
    } else {
      ok++;
      console.log(`  ✓ ${filePath.split("/").pop()} (${Math.round(blob.size / 1024)}KB)`);
    }
  } catch (e) {
    fail++;
    console.log(`  ERROR ${filePath}: ${e.message}`);
  }
}

console.log(`\nDone: ${ok} copied, ${fail} failed`);
if (ok > 0) {
  console.log("\n✅ Files imported! User's project files are now in the new project's audio bucket.");
  console.log("   They need to have their generation DB record imported separately.");
  console.log(`   Project UUID: ${PROJECT_UUID}`);
  console.log(`   Generation UUID: 75b556e2-d479-4fde-a4b4-aed52e1b84cc`);
}
