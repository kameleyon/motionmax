#!/usr/bin/env node
// Find OpenRouter video models that support BOTH last_frame AND 10s
// duration, then sort by price (cheapest first). No generations are
// fired — this only reads the catalog so it costs nothing.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/probe-openrouter-pricing.mjs
//
// What it prints, per surviving model:
//   - id, name
//   - supported_durations (must contain 10)
//   - raw pricing_skus shape (so we can see flat vs per-duration)
//   - effective price at 10s (best-guess from the structure)

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }

const BASE = "https://openrouter.ai/api/v1";
const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "HTTP-Referer": "https://motionmax.app",
  "X-Title": "motionmax pricing probe",
};

const res = await fetch(`${BASE}/videos/models`, { headers: HEADERS });
if (!res.ok) { console.error(`models HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
const { data: models } = await res.json();

const candidates = models.filter((m) => {
  const hasLast = (m.supported_frame_images ?? []).includes("last_frame");
  const has10s  = (m.supported_durations ?? []).map(Number).includes(10);
  return hasLast && has10s;
});

// Compute "price for a 10s, 720p, image-to-video, no audio" clip from
// whatever shape pricing_skus has. Observed shapes on OpenRouter:
//
//   { duration_seconds: "0.10", ... }
//        → linear $/sec: 10s = 10 × rate. Prefer
//          image_to_video_duration_seconds_720p if present.
//
//   { video_tokens: "0.0000056", video_tokens_without_audio: "0.0000012" }
//        → per-token: 10s = 10 × TOKENS_PER_SEC × rate. Prefer no-audio.
//          720p ≈ 21,400 tokens/sec, derived empirically from prior probe.
//
//   { generate: "0.50" }            → flat per-generation
//   { generate: { "10": "1.00" } }  → per-duration keyed
const TOKENS_PER_SEC_720P = 21400;

function priceAt10s(m) {
  const s = m.pricing_skus ?? {};

  // Shape A: duration_seconds (Kling, Wan, Kling-O1)
  const perSec =
    s.image_to_video_duration_seconds_720p ??
    s.text_to_video_duration_seconds_720p ??
    s.duration_seconds;
  if (perSec != null) {
    return { value: Number(perSec) * 10, basis: `${Number(perSec)}/sec × 10s` };
  }

  // Shape B: video_tokens (Seedance) — prefer the cheaper no-audio rate
  const perToken = s.video_tokens_without_audio ?? s.video_tokens;
  if (perToken != null) {
    const v = Number(perToken) * TOKENS_PER_SEC_720P * 10;
    return { value: v, basis: `${Number(perToken)}/token × ${TOKENS_PER_SEC_720P}/s × 10s` };
  }

  // Shape C: generate (flat or per-duration)
  const g = s.generate;
  if (typeof g === "string" || typeof g === "number") return { value: Number(g), basis: "flat" };
  if (g && typeof g === "object" && g["10"] != null) return { value: Number(g["10"]), basis: "per-duration['10']" };

  return { value: null, basis: "unrecognized" };
}

const ranked = candidates
  .map((m) => ({ m, ...priceAt10s(m) }))
  .sort((a, b) => {
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return a.value - b.value;
  });

console.log(`\n▶ ${candidates.length} models support BOTH last_frame AND 10s duration\n`);
console.log("━━━ Sorted by 10s price (cheapest first) ━━━\n");
for (const { m, value, basis } of ranked) {
  const price = value == null ? "?" : `$${value.toFixed(2)}`;
  console.log(`  ${price.padEnd(7)}  ${m.id}`);
  console.log(`           durations: ${JSON.stringify(m.supported_durations)}   basis: ${basis}`);
  console.log(`           pricing_skus: ${JSON.stringify(m.pricing_skus)}`);
  console.log("");
}
