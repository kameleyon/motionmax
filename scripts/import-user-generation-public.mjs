/**
 * import-user-generation-public.mjs
 * Imports the specific user's generation from the old project using public bucket access.
 * Lists files via the storage REST API, then copies them to the new project.
 */

import { createClient } from "@supabase/supabase-js";

const SOURCE_URL = "https://hesnceozbedzrgvylqrm.supabase.co";
const SOURCE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhlc25jZW96YmVkenJndnlscXJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxNTUyOTIsImV4cCI6MjA4MzczMTI5Mn0.YU881FNTJeR_FAbOV3bTGBmUvYbbQfAX5KaHI6uq--U";

const TARGET_URL = "https://ayjbvcikuwknqdrpsdmj.supabase.co";
const TARGET_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5amJ2Y2lrdXdrbnFkcnBzZG1qIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMTQyMywiZXhwIjoyMDg4Njc3NDIzfQ.GrVfcz55PBPdxuWOimXFCjXrV-TrgsNcr0aJZ25xIcQ";
const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;

const USER_ID = "ce695137-9517-409d-bfc1-d51ad61db1db";

const src = createClient(SOURCE_URL, SOURCE_ANON);
const tgt = createClient(TARGET_URL, TARGET_SVC);

async function dbQuery(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

// 1. List files in the user's folder on the old project
console.log(`Listing files for user ${USER_ID} on old project...`);

const listResult = await src.storage.from("audio").list(USER_ID, { limit: 1000 });
if (listResult.error) {
  console.error("Could not list user folder:", listResult.error.message);
  // Try listing all folders at top level to find this user
  const topLevel = await src.storage.from("audio").list("", { limit: 1000 });
  console.log("Top level items:", JSON.stringify(topLevel.data?.slice(0, 5)));
  process.exit(1);
}

console.log(`Found ${listResult.data?.length || 0} subfolders for user\n`);

// Recursively list all files in the user's folder
async function listAllFiles(prefix) {
  const files = [];
  const { data, error } = await src.storage.from("audio").list(prefix, { limit: 1000 });
  if (error || !data) return files;
  for (const item of data) {
    if (item.id) {
      files.push(`${prefix}/${item.name}`);
    } else {
      const nested = await listAllFiles(`${prefix}/${item.name}`);
      files.push(...nested);
    }
  }
  return files;
}

const allFiles = await listAllFiles(USER_ID);
console.log(`Total files found: ${allFiles.length}`);

// 2. Copy each file to the new project
let ok = 0;
let fail = 0;
for (const filePath of allFiles) {
  const url = `${SOURCE_URL}/storage/v1/object/public/audio/${filePath}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  SKIP ${filePath}: HTTP ${res.status}`);
      fail++;
      continue;
    }
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
      if (ok % 20 === 0) process.stdout.write(`\r  Copied: ${ok}/${allFiles.length}`);
    }
  } catch (e) {
    fail++;
    console.log(`  ERROR ${filePath}: ${e.message}`);
  }
}
console.log(`\n\nCopied: ${ok}, Failed: ${fail} out of ${allFiles.length}\n`);

// 3. Also check for DB records in the old project via REST API
console.log("Fetching generation records from old project...");
const genRes = await fetch(
  `${SOURCE_URL}/rest/v1/generations?user_id=eq.${USER_ID}&order=created_at.desc&limit=10`,
  { headers: { Authorization: `Bearer ${SOURCE_ANON}`, apikey: SOURCE_ANON } }
);
const genData = genRes.ok ? await genRes.json() : [];
console.log(`Found ${genData.length} generations (may be 0 due to RLS)\n`);

if (genData.length > 0) {
  // Import each generation to the new project
  for (const gen of genData) {
    // First ensure the project exists
    const projRes = await fetch(
      `${SOURCE_URL}/rest/v1/projects?id=eq.${gen.project_id}`,
      { headers: { Authorization: `Bearer ${SOURCE_ANON}`, apikey: SOURCE_ANON } }
    );
    const projects = projRes.ok ? await projRes.json() : [];
    
    for (const proj of projects) {
      await dbQuery(`
        INSERT INTO projects (id, user_id, title, content, format, length, style, project_type, status, created_at, updated_at)
        VALUES ('${proj.id}', '${proj.user_id}', '${(proj.title || '').replace(/'/g, "''")}', '${(proj.content || '').replace(/'/g, "''")}', '${proj.format || 'landscape'}', '${proj.length || 'short'}', '${proj.style || 'realistic'}', '${proj.project_type || 'doc2video'}', '${proj.status || 'complete'}', '${proj.created_at}', '${proj.updated_at}')
        ON CONFLICT (id) DO NOTHING
      `);
    }

    // Then insert the generation
    const scenesJson = JSON.stringify(gen.scenes || null).replace(/'/g, "''");
    await dbQuery(`
      INSERT INTO generations (id, user_id, project_id, status, progress, scenes, audio_url, video_url, created_at, updated_at)
      VALUES ('${gen.id}', '${gen.user_id}', '${gen.project_id}', '${gen.status}', ${gen.progress || 100}, '${scenesJson}'::jsonb, ${gen.audio_url ? `'${gen.audio_url}'` : 'NULL'}, ${gen.video_url ? `'${gen.video_url}'` : 'NULL'}, '${gen.created_at}', '${gen.updated_at}')
      ON CONFLICT (id) DO NOTHING
    `);
    console.log(`Imported generation: ${gen.id}`);
  }

  // Update URLs to point to new project
  await dbQuery(`
    UPDATE generations
    SET
      scenes = replace(scenes::text, 'hesnceozbedzrgvylqrm', 'ayjbvcikuwknqdrpsdmj')::jsonb,
      audio_url = replace(audio_url, 'hesnceozbedzrgvylqrm', 'ayjbvcikuwknqdrpsdmj'),
      video_url = replace(video_url, 'hesnceozbedzrgvylqrm', 'ayjbvcikuwknqdrpsdmj')
    WHERE user_id = '${USER_ID}' AND created_at >= NOW() - INTERVAL '7 days'
  `);
}

console.log("✅ Done!");
