#!/usr/bin/env node
// Probe Hypereal pricing — fires one or more generation requests and
// reports the `creditsUsed` value from each response. Use when you
// want to verify Hypereal's billing is what it should be (or after
// they've claimed to "fix prices").
//
// Reads HYPEREAL_API_KEY (account A — image/audio/LLM tier) from env.
// Set HYPEREALIMAGE_API_KEY too if you want to probe the video tier.
//
// Modes (pass as args):
//   default                  → image gen only
//   --video kling-v3-pro     → probe Kling V3 Pro video (~39 cr)
//   --video seedance-fast    → probe Seedance 2.0 Fast (~25-30 cr)
//   --all                    → image + both videos
//
// Each probe prints: model, http status, credits used, error if any.

const HYPEREAL_IMAGE_URL = "https://api.hypereal.cloud/v1/images/generate";
const HYPEREAL_VIDEO_URL = "https://api.hypereal.cloud/v1/videos/generate";
const TEST_IMAGE_URL = "https://picsum.photos/seed/motionmax-probe/1024/1024";

const argv = new Set(process.argv.slice(2));
const wantImage = !argv.has("--no-image");
const wantAll = argv.has("--all");
const wantVideoKling = wantAll || argv.has("--video-kling") || process.argv.includes("kling-v3-pro");
const wantVideoSeedance = wantAll || argv.has("--video-seedance") || process.argv.includes("seedance-fast");

const KEY_IMAGE = process.env.HYPEREAL_API_KEY;
const KEY_VIDEO = process.env.HYPEREALIMAGE_API_KEY || process.env.HYPEREAL_API_KEY;
if (!KEY_IMAGE) {
  console.error("Missing HYPEREAL_API_KEY in env");
  process.exit(1);
}

console.log(`▶ Hypereal pricing probe`);
console.log(`▶ HYPEREAL_API_KEY      = …${KEY_IMAGE.slice(-6)} (length ${KEY_IMAGE.length})`);
console.log(`▶ HYPEREALIMAGE_API_KEY = …${KEY_VIDEO?.slice(-6) ?? "(unset)"}`);
console.log("");

async function probe(label, url, body, key) {
  const t0 = Date.now();
  console.log(`━━━ ${label} ━━━`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const dur = Math.round((Date.now() - t0) / 100) / 10;
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    console.log(`  HTTP ${res.status}  (${dur}s)`);
    if (parsed) {
      const data = parsed.data ?? parsed;
      console.log(`  jobId:        ${data?.jobId ?? data?.id ?? "(none)"}`);
      console.log(`  creditsUsed:  ${data?.creditsUsed ?? "(not in response)"}`);
      console.log(`  status:       ${data?.status ?? parsed?.status ?? "(none)"}`);
      if (parsed.message || parsed.error) console.log(`  msg/err:      ${parsed.message ?? parsed.error}`);
      if (data?.balance !== undefined) console.log(`  balance:      ${data.balance}`);
      // Print top-level keys so we can see the shape
      const topKeys = Object.keys(parsed).filter((k) => k !== "data").slice(0, 8);
      if (topKeys.length) console.log(`  top keys:     [${topKeys.join(", ")}]`);
      const dataKeys = parsed.data ? Object.keys(parsed.data).slice(0, 12) : [];
      if (dataKeys.length) console.log(`  data keys:    [${dataKeys.join(", ")}]`);
    } else {
      console.log(`  raw body (first 400): ${text.slice(0, 400)}`);
    }
  } catch (e) {
    console.log(`  threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log("");
}

if (wantImage) {
  await probe("IMAGE — gemini-3-1-flash-t2i (16:9)", HYPEREAL_IMAGE_URL, {
    prompt: "A stylized 3D animated globe rotating slowly, vibrant colors, clean cinematic lighting",
    model: "gemini-3-1-flash-t2i",
    format: "16:9",
  }, KEY_IMAGE);
}

if (wantVideoSeedance) {
  await probe("VIDEO — seedance-2-0-fast-i2v (5s, 480p, 16:9)", HYPEREAL_VIDEO_URL, {
    model: "seedance-2-0-fast-i2v",
    prompt: "Slow cinematic pan across a tactical football pitch overhead view, motion blur, soft glow",
    image_url: TEST_IMAGE_URL,
    duration: 5,
    aspect_ratio: "16:9",
    resolution: "480p",
    generate_audio: false,
  }, KEY_VIDEO);
}

if (wantVideoKling) {
  await probe("VIDEO — kling-3-0-pro-i2v (5s, 16:9)", HYPEREAL_VIDEO_URL, {
    model: "kling-3-0-pro-i2v",
    prompt: "Slow cinematic pan across a tactical football pitch overhead view, motion blur, soft glow",
    image_url: TEST_IMAGE_URL,
    duration: 5,
    aspect_ratio: "16:9",
  }, KEY_VIDEO);
}

if (!wantImage && !wantVideoKling && !wantVideoSeedance) {
  console.log("Nothing requested. Try: node scripts/probe-hypereal-pricing.mjs --all");
}
