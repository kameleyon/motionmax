#!/usr/bin/env node
// Probe OpenRouter's video-generation API.
//
// Step 1: list models, filter for Seedance + any model with last_frame support.
// Step 2 (if --generate): fire one test prediction with first+last frames and
//         print the response shape including pricing + supported_frame_images.
//
// Reads OPENROUTER_API_KEY from env. Usage:
//   set -a && source worker/.env && set +a
//   node scripts/probe-openrouter-video.mjs              # list + filter
//   node scripts/probe-openrouter-video.mjs --generate   # also run a test
//
// Docs reference (per user):
//   create:   https://openrouter.ai/docs/api/api-reference/video-generation/create-videos
//   get:      https://openrouter.ai/docs/api/api-reference/video-generation/get-videos
//   models:   https://openrouter.ai/docs/api/api-reference/video-generation/list-videos-models
//
// Response shape per model (from user-provided example):
//   {
//     id, canonical_slug, name,
//     supported_aspect_ratios: [...],
//     supported_durations: [...],
//     supported_frame_images: ["first_frame", "last_frame"]   ← THE KEY FIELD
//     supported_resolutions: [...],
//     pricing_skus: { generate: "0.50" },
//     allowed_passthrough_parameters: [...]
//   }

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  console.error("Missing OPENROUTER_API_KEY in env");
  process.exit(1);
}

const BASE = "https://openrouter.ai/api/v1";
const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  // OpenRouter likes these for attribution but they're optional:
  "HTTP-Referer": "https://motionmax.app",
  "X-Title": "motionmax video probe",
};

const wantGenerate = process.argv.includes("--generate");

// ── Step 1: list video models ─────────────────────────────────────
console.log("▶ Listing OpenRouter video models...\n");
const listRes = await fetch(`${BASE}/videos/models`, { headers: HEADERS });
if (!listRes.ok) {
  console.error(`models endpoint HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 300)}`);
  process.exit(1);
}
const { data: models } = await listRes.json();
console.log(`  Total video models available: ${models.length}\n`);

// Filter for Seedance + anything with last_frame support
const seedance = models.filter((m) => /seedance|seed-dance|bytedance/i.test(m.id + " " + (m.name ?? "") + " " + (m.canonical_slug ?? "")));
const withLastFrame = models.filter((m) => (m.supported_frame_images ?? []).includes("last_frame"));

console.log(`━━━ Seedance variants on OpenRouter ━━━`);
if (seedance.length === 0) console.log("  (none found)");
for (const m of seedance) printModel(m);

console.log(`\n━━━ ALL models supporting last_frame ━━━`);
if (withLastFrame.length === 0) console.log("  (none — OpenRouter has no last_frame I2V model)");
for (const m of withLastFrame) printModel(m);

// ── Step 2: optionally fire a generation ──────────────────────────
if (wantGenerate) {
  // Prefer a Seedance model with last_frame support; else any with last_frame
  const target = seedance.find((m) => (m.supported_frame_images ?? []).includes("last_frame"))
    ?? withLastFrame[0];
  if (!target) {
    console.log("\n  No model supports last_frame — skipping generation test.");
    process.exit(0);
  }
  console.log(`\n━━━ Firing test generation on ${target.id} ━━━`);
  const dur = (target.supported_durations ?? [5])[0];
  const ar = (target.supported_aspect_ratios ?? ["16:9"])[0];
  const res = (target.supported_resolutions ?? ["720p"])[0];
  // OpenRouter's create-video schema (per docs read 2026-05-16):
  // frame_images is an ARRAY of OpenAI-content-style objects with
  // type="image_url", frame_type="first_frame"|"last_frame", and the
  // URL nested under image_url.url. NOT top-level first_frame/last_frame.
  const body = {
    model: target.id,
    prompt: "A stylized cinematic transition between two scenes, smooth pan, cinematic lighting",
    frame_images: [
      {
        type: "image_url",
        frame_type: "first_frame",
        image_url: { url: "https://picsum.photos/seed/motionmax-first/1024/576" },
      },
      {
        type: "image_url",
        frame_type: "last_frame",
        image_url: { url: "https://picsum.photos/seed/motionmax-last/1024/576" },
      },
    ],
    duration: dur,
    aspect_ratio: ar,
    resolution: res,
  };
  console.log("  Request body:", JSON.stringify(body, null, 2));
  const t0 = Date.now();
  const genRes = await fetch(`${BASE}/videos`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n  HTTP ${genRes.status}  (${elapsed}s to first response)`);
  const text = await genRes.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed) {
    console.log("  Response:", JSON.stringify(parsed, null, 2));
    const videoId = parsed.id ?? parsed.data?.id;
    if (videoId) {
      console.log(`\n  Poll status:  GET ${BASE}/videos/${videoId}`);
      console.log(`  Run:          node scripts/probe-openrouter-video.mjs --poll ${videoId}`);
    }
  } else {
    console.log("  raw body:", text.slice(0, 600));
  }
}

function printModel(m) {
  console.log(`  ${m.id}`);
  console.log(`    name:                ${m.name ?? "(no name)"}`);
  console.log(`    canonical_slug:      ${m.canonical_slug ?? "(none)"}`);
  console.log(`    durations:           ${JSON.stringify(m.supported_durations ?? [])}`);
  console.log(`    aspect_ratios:       ${JSON.stringify(m.supported_aspect_ratios ?? [])}`);
  console.log(`    resolutions:         ${JSON.stringify(m.supported_resolutions ?? [])}`);
  console.log(`    frame_images:        ${JSON.stringify(m.supported_frame_images ?? [])}  ${(m.supported_frame_images ?? []).includes("last_frame") ? "✅ last_frame" : "❌ no last_frame"}`);
  console.log(`    pricing (generate):  $${m.pricing_skus?.generate ?? "?"}`);
  console.log(`    passthrough_params:  ${JSON.stringify(m.allowed_passthrough_parameters ?? [])}`);
  console.log("");
}
