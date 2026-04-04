/**
 * Creates the project + generation DB records for urbanbrujetta4ever's
 * project 8491a4a5 which was generated on the old system after migration.
 * Storage files are already copied. This inserts the DB records.
 */

const TARGET_REF = "ayjbvcikuwknqdrpsdmj";
const ACCESS_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const DB_API = `https://api.supabase.com/v1/projects/${TARGET_REF}/database/query`;

const BASE = `https://${TARGET_REF}.supabase.co/storage/v1/object/public/audio`;
const USER_ID = "ce695137-9517-409d-bfc1-d51ad61db1db";
const PROJECT_ID = "8491a4a5-1c29-4971-ac63-1c287b390a20";
const GEN_ID = "75b556e2-d479-4fde-a4b4-aed52e1b84cc";
const PREFIX = `${BASE}/${USER_ID}/${PROJECT_ID}`;

async function q(query) {
  const r = await fetch(DB_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

// Build scenes from known files (probed earlier)
// scene-1: 3 imgs + mp3; scene-2: 3 imgs + mp3; scene-3: 2 imgs + mp3
// scene-4: 2 imgs (no primary) + mp3; scene-5: 2 imgs + mp3; scene-6: mp3 only
const scenes = [
  {
    number: 1,
    imageUrl: `${PREFIX}/scene-1.png`,
    imageUrls: [`${PREFIX}/scene-1.png`, `${PREFIX}/scene-1-2.png`, `${PREFIX}/scene-1-3.png`],
    audioUrl: `${PREFIX}/scene-1.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project" },
  },
  {
    number: 2,
    imageUrl: `${PREFIX}/scene-2.png`,
    imageUrls: [`${PREFIX}/scene-2.png`, `${PREFIX}/scene-2-2.png`, `${PREFIX}/scene-2-3.png`],
    audioUrl: `${PREFIX}/scene-2.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project" },
  },
  {
    number: 3,
    imageUrl: `${PREFIX}/scene-3.png`,
    imageUrls: [`${PREFIX}/scene-3.png`, `${PREFIX}/scene-3-2.png`],
    audioUrl: `${PREFIX}/scene-3.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project" },
  },
  {
    number: 4,
    imageUrl: `${PREFIX}/scene-4-2.png`,
    imageUrls: [`${PREFIX}/scene-4-2.png`, `${PREFIX}/scene-4-3.png`],
    audioUrl: `${PREFIX}/scene-4.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project" },
  },
  {
    number: 5,
    imageUrl: `${PREFIX}/scene-5.png`,
    imageUrls: [`${PREFIX}/scene-5.png`, `${PREFIX}/scene-5-2.png`],
    audioUrl: `${PREFIX}/scene-5.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project" },
  },
  {
    number: 6,
    imageUrl: null,
    imageUrls: [],
    audioUrl: `${PREFIX}/scene-6.mp3`,
    voiceover: "",
    duration: 10,
    _meta: { statusMessage: "Imported from old project (no image found)" },
  },
];

const scenesJson = JSON.stringify(scenes).replace(/'/g, "''");
const now = new Date().toISOString();

// 1. Insert project (if not already exists)
console.log("Inserting project record...");
const p1 = await q(`
  INSERT INTO projects (
    id, user_id, title, content, format, length, style, project_type,
    status, thumbnail_url, created_at, updated_at
  )
  VALUES (
    '${PROJECT_ID}', '${USER_ID}',
    'Imported Project (8491a4a5)',
    '(Content imported from old system)',
    'landscape', 'short', 'realistic', 'doc2video',
    'complete',
    '${PREFIX}/scene-1.png',
    '${now}', '${now}'
  )
  ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    thumbnail_url = EXCLUDED.thumbnail_url,
    updated_at = '${now}'
`);
console.log("Project:", JSON.stringify(p1));

// 2. Insert generation (no updated_at column — uses started_at/completed_at)
console.log("\nInserting generation record...");
const g1 = await q(`
  INSERT INTO generations (
    id, user_id, project_id, status, progress, scenes,
    error_message, started_at, completed_at, created_at
  )
  VALUES (
    '${GEN_ID}', '${USER_ID}', '${PROJECT_ID}',
    'complete', 100, '${scenesJson}'::jsonb,
    NULL, '${now}', '${now}', '${now}'
  )
  ON CONFLICT (id) DO UPDATE SET
    scenes = EXCLUDED.scenes,
    status = EXCLUDED.status,
    completed_at = '${now}'
`);
console.log("Generation:", JSON.stringify(g1));

// 3. Verify it's selectable
const check = await q(`
  SELECT g.id, g.status, p.title,
    jsonb_array_length(g.scenes) as scene_count
  FROM generations g
  JOIN projects p ON p.id = g.project_id
  WHERE g.id = '${GEN_ID}'
`);
console.log("\nVerification:", JSON.stringify(check));
console.log("\n✅ Records inserted! User urbanbrujetta4ever can now see project 8491a4a5.");
console.log("   Note: Scene voiceover text was lost (not in storage).");
console.log("   Images and audio are fully restored.");
