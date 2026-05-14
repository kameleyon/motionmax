#!/usr/bin/env node
/**
 * Replicate Seedance 2.0 last_image probe — mirror of the OpenRouter
 * test from earlier today. Submits an I2V request with both `image`
 * (first frame) and `last_image` (end frame), polls the prediction
 * to completion, downloads the mp4, and extracts the first + last
 * video frames so you can eyeball-compare against the input frames.
 *
 * Why: when we evaluated Replicate Seedance ~12 hours ago, the
 * verdict was "field accepted but silently ignored" — same trap as
 * OpenRouter. Re-testing now to confirm whether anything changed
 * upstream (model schema updates, bug fix, etc.) before considering
 * a migration.
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (for image upload + signing)
 *   REPLICATE_API_KEY                        (the prediction submit)
 *
 * Optional args:
 *   $1  path to local start-frame jpeg (default _start_repl.jpg below)
 *   $2  path to local end-frame jpeg   (default _end_repl.jpg below)
 *
 * Cost: 5s @ 480p = ~$0.40. Cheap enough for one-shot probes.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
if (!SUPABASE_URL || !SERVICE_KEY || !REPLICATE_KEY) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REPLICATE_API_KEY");
  process.exit(1);
}

const startLocal = process.argv[2] || "scripts/.probe-output/_start_repl.jpg";
const endLocal   = process.argv[3] || "scripts/.probe-output/_end_repl.jpg";
if (!existsSync(startLocal) || !existsSync(endLocal)) {
  console.error(`Missing input image(s):\n  ${startLocal}\n  ${endLocal}`);
  console.error("Run ffmpeg to prepare them first (see README in this script's header).");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── 1. Upload + sign URLs ───────────────────────────────────────────
const stamp = Date.now();
async function up(local, name) {
  const buf = readFileSync(local);
  const remote = `probe-repl/${stamp}/${name}`;
  const { error } = await sb.storage.from("scene-images").upload(remote, buf, {
    contentType: "image/jpeg", upsert: true,
  });
  if (error) throw new Error(`upload ${name}: ${error.message}`);
  const { data, error: e2 } = await sb.storage
    .from("scene-images").createSignedUrl(remote, 3600);
  if (e2) throw new Error(`sign ${name}: ${e2.message}`);
  return data.signedUrl;
}
const startUrl = await up(startLocal, "start.jpg");
const endUrl = await up(endLocal, "end.jpg");
console.log("Uploaded:");
console.log("  start:", startUrl);
console.log("  end:  ", endUrl);

// ── 2. Submit prediction ────────────────────────────────────────────
// Exact same shape worker/src/services/replicateSeedance.ts uses,
// so a positive result here means the worker's existing code path
// would also work; a negative result confirms the silent-drop bug.
const body = {
  input: {
    prompt: "Smooth cinematic camera move that gradually transitions between the two scenes shown.",
    image: startUrl,
    // Field name is `last_frame_image` (NOT `last_image`). Replicate's
    // schema ignores unknown fields silently, which is why the worker's
    // existing replicateSeedance.ts has been a no-op on end-frame for
    // weeks. Corrected 2026-05-14 from a working playground payload.
    last_frame_image: endUrl,
    duration: 5,
    resolution: "480p",
    aspect_ratio: "1:1",
    generate_audio: false,
  },
};

console.log("\n▶ POST https://api.replicate.com/v1/models/bytedance/seedance-2.0/predictions");
console.log("  input.image:            ", body.input.image.slice(0, 80) + "...");
console.log("  input.last_frame_image: ", body.input.last_frame_image.slice(0, 80) + "...");

const submitRes = await fetch(
  "https://api.replicate.com/v1/models/bytedance/seedance-2.0/predictions",
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${REPLICATE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  },
);
const submitText = await submitRes.text();
console.log(`  HTTP ${submitRes.status}`);
let prediction;
try { prediction = JSON.parse(submitText); } catch { prediction = null; }
if (!submitRes.ok || !prediction?.id) {
  console.error("Submit failed:", submitText.slice(0, 500));
  process.exit(2);
}
const predictionId = prediction.id;
const pollUrl = prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${predictionId}`;
console.log(`  prediction: ${predictionId}  status=${prediction.status}`);

// ── 3. Poll ─────────────────────────────────────────────────────────
const t0 = Date.now();
let final = null;
let n = 0;
while (Date.now() - t0 < 10 * 60_000) {
  n++;
  await new Promise((r) => setTimeout(r, 5000));
  const pr = await fetch(pollUrl, {
    headers: { "Authorization": `Bearer ${REPLICATE_KEY}` },
  });
  if (!pr.ok) {
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] poll #${n}: HTTP ${pr.status}, retrying`);
    continue;
  }
  const pj = await pr.json();
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  [${elapsed}s] #${n} ${pj.status}`);
  if (pj.status === "succeeded") { final = pj; break; }
  if (pj.status === "failed" || pj.status === "canceled") {
    console.error("Prediction failed:", pj.error ?? "(no error)");
    console.error("Full response:", JSON.stringify(pj, null, 2).slice(0, 800));
    process.exit(3);
  }
}
if (!final) { console.error("Poll timed out (10min)."); process.exit(4); }

// Replicate returns `output` as a single URL string OR an array of URLs.
const videoUrl = Array.isArray(final.output) ? final.output[0] : final.output;
if (!videoUrl) {
  console.error("No output URL on succeeded prediction:", JSON.stringify(final, null, 2).slice(0, 500));
  process.exit(5);
}
console.log(`\n✓ Video URL: ${videoUrl}`);

// ── 4. Download + extract frames ────────────────────────────────────
const outMp4 = path.resolve("scripts/.probe-output/replicate-probe.mp4");
const vidRes = await fetch(videoUrl);
const buf = Buffer.from(await vidRes.arrayBuffer());
writeFileSync(outMp4, buf);
console.log(`  saved ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${outMp4}`);

console.log("\n──────────────────────────────────────────");
console.log("  Compare via ffmpeg:");
console.log(`    ffmpeg -y -i ${outMp4} -vframes 1 _replicate_first.jpg`);
console.log(`    ffmpeg -y -sseof -1 -i ${outMp4} -update 1 -q:v 2 _replicate_last.jpg`);
console.log(`  Then open _replicate_first.jpg, _replicate_last.jpg, ${startLocal}, ${endLocal} side-by-side.`);
console.log("──────────────────────────────────────────\n");
