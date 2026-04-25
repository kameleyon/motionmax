#!/usr/bin/env node
/**
 * Backfill: re-clone every existing ElevenLabs voice via Fish IVC.
 *
 * Why: We swapped voice cloning from ElevenLabs to Fish s2-pro for
 * higher quality + multi-language support, but existing user_voices
 * rows hold ElevenLabs voice ids that ONLY work with ElevenLabs'
 * API. The audio router would route them through ElevenLabs forever
 * unless we re-clone the original sample through Fish and update the
 * row to provider='fish' with the new Fish model id.
 *
 * Idempotent — skips rows already marked provider='fish'.
 *
 * Usage:
 *   node scripts/backfill-fish-voices.mjs
 *
 * Required env (read from worker/.env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   FISH_AUDIO_API_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: "worker/.env" });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FISH_KEY = process.env.FISH_AUDIO_API_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in worker/.env");
  process.exit(1);
}
if (!FISH_KEY) {
  console.error("Missing FISH_AUDIO_API_KEY in worker/.env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function transcodeToMp3(input, ext) {
  const dir = await mkdtemp(join(tmpdir(), "fish-backfill-"));
  const inPath = join(dir, `in.${ext}`);
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, input);
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y", "-i", inPath, "-vn",
        "-ac", "1", "-ar", "44100",
        "-codec:a", "libmp3lame", "-q:a", "2",
        outPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (b) => { stderr += b.toString(); });
      ff.on("error", reject);
      ff.on("close", (c) => c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}: ${stderr.slice(-300)}`)));
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadSample(storagePath) {
  const { data, error } = await supabase.storage.from("voice_samples").download(storagePath);
  if (error || !data) throw new Error(`download failed: ${error?.message}`);
  const buf = await data.arrayBuffer();
  const ext = (storagePath.split(".").pop() || "webm").toLowerCase();
  return { bytes: Buffer.from(buf), ext };
}

async function fishClone(voiceName, mp3Bytes) {
  const form = new FormData();
  form.append("title", voiceName);
  form.append("type", "tts");
  form.append("train_mode", "fast");
  form.append("enhance_audio_quality", "true");
  form.append("visibility", "private");
  form.append(
    "voices",
    new Blob([new Uint8Array(mp3Bytes)], { type: "audio/mpeg" }),
    `${voiceName.replace(/[^a-z0-9]/gi, "_")}.mp3`,
  );

  const res = await fetch("https://api.fish.audio/model", {
    method: "POST",
    headers: { Authorization: `Bearer ${FISH_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fish IVC ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json._id || json.id;
}

async function main() {
  console.log("Loading user_voices rows that need backfilling…");
  const { data: rows, error } = await supabase
    .from("user_voices")
    .select("id, user_id, voice_name, voice_id, original_sample_path, provider, sample_url")
    .eq("provider", "elevenlabs");

  if (error) {
    console.error("Failed to query user_voices:", error.message);
    process.exit(1);
  }

  console.log(`Found ${rows.length} ElevenLabs row(s) to migrate.`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const path = row.original_sample_path;
    if (!path) {
      console.warn(`  ⊘ ${row.voice_name} (${row.id.slice(0, 8)}) — no original_sample_path, skipping`);
      skipped++;
      continue;
    }

    try {
      console.log(`  → ${row.voice_name} (${row.id.slice(0, 8)}) — downloading ${path}`);
      const { bytes, ext } = await downloadSample(path);
      console.log(`    transcoding ${bytes.length} bytes (${ext}) → MP3`);
      const mp3 = await transcodeToMp3(bytes, ext);
      console.log(`    Fish IVC training (${mp3.length} bytes MP3)…`);
      const fishId = await fishClone(row.voice_name, mp3);
      console.log(`    ✅ Fish id: ${fishId}`);

      const { error: updErr } = await supabase
        .from("user_voices")
        .update({ voice_id: fishId, provider: "fish" })
        .eq("id", row.id);
      if (updErr) throw new Error(`row update failed: ${updErr.message}`);

      migrated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    ✗ Failed: ${msg}`);
      failed++;
    }
  }

  console.log("");
  console.log(`Done. migrated=${migrated} skipped=${skipped} failed=${failed} total=${rows.length}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
