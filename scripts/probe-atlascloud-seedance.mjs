#!/usr/bin/env node
/**
 * AtlasCloud Seedance probe — same I2V last_frame_image test we ran
 * against Replicate and Hypereal, this time against AtlasCloud's
 * /api/v1/model/generateVideo endpoint.
 *
 * Why test:
 *  1. Verify AtlasCloud's API actually honors first + last frame
 *     (the OpenAPI spec promises it; spec promises ≠ runtime reality
 *     — we've been burned twice already today by silently-dropped
 *     image fields on OpenRouter).
 *  2. See if AtlasCloud's content moderation is more permissive than
 *     Replicate's (which keeps returning E005 "flagged as sensitive"
 *     on prompts with "real human / real face / real skin" phrasing).
 *
 * Required env:
 *   ATLASCLOUD_API_KEY                       (probe auth)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (image upload + signing)
 *
 * Optional args:
 *   $1  local start jpeg  (default scripts/.probe-output/_start_ac.jpg)
 *   $2  local end jpeg    (default scripts/.probe-output/_end_ac.jpg)
 *
 * The spec from the user's paste is truncated — the Input schema body
 * isn't fully visible. We submit with the inferred fields (prompt,
 * image, last_frame_image, duration, resolution, aspect_ratio,
 * generate_audio) and let AtlasCloud's 400 response tell us if any
 * field is wrong.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ATLAS_KEY = process.env.ATLASCLOUD_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY || !ATLAS_KEY) {
  console.error("Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLASCLOUD_API_KEY");
  process.exit(1);
}

const startLocal = process.argv[2] || "scripts/.probe-output/_start_ac.jpg";
const endLocal = process.argv[3] || "scripts/.probe-output/_end_ac.jpg";
if (!existsSync(startLocal) || !existsSync(endLocal)) {
  console.error(`Missing: ${startLocal} or ${endLocal}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Upload (Replicate-style: same buckets, public URLs work because
//    we restored public=true earlier today)
const stamp = Date.now();
async function up(local, name) {
  const buf = readFileSync(local);
  const remote = `probe-ac/${stamp}/${name}`;
  const { error } = await sb.storage.from("scene-images").upload(remote, buf, {
    contentType: "image/jpeg", upsert: true,
  });
  if (error) throw new Error(error.message);
  // Use the public URL (bucket is public=true) — same format Replicate fetches.
  const { data } = sb.storage.from("scene-images").getPublicUrl(remote);
  return data.publicUrl;
}
const startUrl = await up(startLocal, "start.jpg");
const endUrl = await up(endLocal, "end.jpg");
console.log("Uploaded:");
console.log("  start:", startUrl);
console.log("  end:  ", endUrl);

// ── Submit ──────────────────────────────────────────────────────────
// AtlasCloud requires a `model` field that wasn't in the truncated
// OpenAPI spec. We'll try common Seedance naming conventions and
// surface the first 400 error to learn the right slug.
// Model slug confirmed from /api/v1/models catalog 2026-05-14.
const MODEL_SLUG = process.env.MODEL_SLUG || "bytedance/seedance-2.0/image-to-video";
const body = {
  model: MODEL_SLUG,
  prompt: "Smooth cinematic camera move that gradually transitions between the two scenes shown.",
  image: startUrl,
  // AtlasCloud schema field name is `last_image` (not last_frame_image
  // like Replicate uses). Per OpenAPI spec: "Last-frame image URL,
  // Base64, or asset reference. The video transitions from the first
  // frame to this last frame."
  last_image: endUrl,
  duration: 5,
  resolution: "480p",
  aspect_ratio: "1:1",
  generate_audio: false,
  return_last_frame: false,
};

console.log("\n▶ POST https://api.atlascloud.ai/api/v1/model/generateVideo");
console.log("  body keys:", Object.keys(body));
const submit = await fetch("https://api.atlascloud.ai/api/v1/model/generateVideo", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${ATLAS_KEY}`,  // empirically: spec says "apiKey" but server requires Bearer prefix
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const submitText = await submit.text();
console.log(`  HTTP ${submit.status}`);
let submitJson;
try { submitJson = JSON.parse(submitText); } catch { submitJson = null; }
console.log("  Response:", JSON.stringify(submitJson ?? submitText, null, 2).slice(0, 800));

if (!submit.ok) {
  // Try the Bearer form too — some APIs accept both
  if (submit.status === 401 || submit.status === 403) {
    console.log("\n  Retrying with Bearer prefix...");
    const retry = await fetch("https://api.atlascloud.ai/api/v1/model/generateVideo", {
      method: "POST",
      headers: { "Authorization": `Bearer ${ATLAS_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const retryText = await retry.text();
    console.log(`  HTTP ${retry.status}`);
    console.log("  Response:", retryText.slice(0, 600));
  }
  process.exit(2);
}

// AtlasCloud nests the response under `data` — id and polling URL both live there.
const requestId = submitJson?.data?.id ?? submitJson?.request_id ?? submitJson?.id ?? submitJson?.prediction_id;
const pollUrlOverride = submitJson?.data?.urls?.get;
if (!requestId) {
  console.error("  Could not find request_id in submit response. Raw:", JSON.stringify(submitJson));
  process.exit(3);
}
console.log(`  request_id: ${requestId}`);

// ── Poll ────────────────────────────────────────────────────────────
const t0 = Date.now();
let final = null;
let n = 0;
while (Date.now() - t0 < 10 * 60_000) {
  n++;
  await new Promise((r) => setTimeout(r, 5000));
  const pollUrl = pollUrlOverride ?? `https://api.atlascloud.ai/api/v1/model/prediction/${requestId}`;
  const pr = await fetch(pollUrl, {
    headers: { "Authorization": `Bearer ${ATLAS_KEY}` },
  });
  const pt = await pr.text();
  let pj;
  try { pj = JSON.parse(pt); } catch { pj = null; }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const status = pj?.data?.status ?? pj?.status ?? pj?.state ?? "unknown";
  console.log(`  [${elapsed}s] #${n} HTTP ${pr.status} status=${status}`);
  if (status === "succeeded" || status === "completed" || pj?.data?.outputs) {
    final = pj;
    break;
  }
  if (status === "failed" || status === "error" || pj?.data?.error) {
    console.error("  failed:", JSON.stringify(pj));
    process.exit(4);
  }
}
if (!final) { console.error("Timed out (10min)"); process.exit(5); }

console.log("\nFinal response (truncated):", JSON.stringify(final, null, 2).slice(0, 800));

// AtlasCloud returns outputs as an array under data.outputs.
const outputs = final?.data?.outputs ?? final?.outputs ?? [];
const videoUrl = Array.isArray(outputs) ? outputs[0] : outputs;

if (!videoUrl) {
  console.error("\nCould not find video URL. Full output:", JSON.stringify(output));
  process.exit(6);
}
console.log(`\n✓ Video URL: ${videoUrl}`);

const outMp4 = path.resolve("scripts/.probe-output/atlascloud-probe.mp4");
const v = await fetch(videoUrl);
const buf = Buffer.from(await v.arrayBuffer());
writeFileSync(outMp4, buf);
console.log(`  saved ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${outMp4}\n`);
