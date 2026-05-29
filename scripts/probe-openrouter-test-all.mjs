#!/usr/bin/env node
// Fire one generation per OpenRouter video model that supports
// last_frame, then poll all of them in parallel. Report which models
// (a) accepted the submission, (b) finished within budget, (c) returned
// a usable video URL.
//
// Uses two distinct picsum images as first/last frame to make
// transitions visually verifiable.
//
// Usage:
//   OPENROUTER_API_KEY=<key> node scripts/probe-openrouter-test-all.mjs
//
// Budget: ~10 min polling per model, capped. Costs typically <$0.50
// per model.

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }

const BASE = "https://openrouter.ai/api/v1";
const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://motionmax.app",
  "X-Title": "motionmax video probe",
};

const FIRST = "https://picsum.photos/seed/motionmax-first/1024/576";
const LAST  = "https://picsum.photos/seed/motionmax-last/1024/576";
const PROMPT = "A stylized cinematic transition between two scenes, smooth pan, cinematic lighting";

// ── 1. fetch all video models, filter for last_frame support ──────
console.log("▶ Listing models with last_frame support...\n");
const listRes = await fetch(`${BASE}/videos/models`, { headers: HEADERS });
if (!listRes.ok) { console.error(`models HTTP ${listRes.status}`); process.exit(1); }
const { data: models } = await listRes.json();
const candidates = models.filter((m) => (m.supported_frame_images ?? []).includes("last_frame"));
console.log(`  ${candidates.length} models support last_frame:`);
for (const m of candidates) console.log(`    - ${m.id}`);
console.log("");

// ── 2. fire one generation per candidate, in parallel ─────────────
console.log("▶ Submitting test generations...\n");
const jobs = await Promise.all(candidates.map(async (m) => {
  const dur = (m.supported_durations ?? [5])[0];
  const ar  = m.supported_aspect_ratios?.includes("16:9") ? "16:9" : (m.supported_aspect_ratios ?? ["1:1"])[0];
  const res = m.supported_resolutions?.includes("720p") ? "720p" : (m.supported_resolutions ?? ["480p"])[0];
  const body = {
    model: m.id,
    prompt: PROMPT,
    frame_images: [
      { type: "image_url", frame_type: "first_frame", image_url: { url: FIRST } },
      { type: "image_url", frame_type: "last_frame",  image_url: { url: LAST  } },
    ],
    duration: dur,
    aspect_ratio: ar,
    resolution: res,
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/videos`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const txt = await r.text();
  let parsed; try { parsed = JSON.parse(txt); } catch { parsed = null; }
  const submitMs = Date.now() - t0;
  return {
    model: m.id,
    submitMs,
    httpStatus: r.status,
    videoId: parsed?.id ?? null,
    pollUrl: parsed?.polling_url ?? null,
    initialStatus: parsed?.status ?? null,
    error: r.ok ? null : (parsed?.error?.message ?? txt.slice(0, 200)),
    finalStatus: null,
    finalUrl: null,
    finalError: null,
    pollMs: 0,
    cost: parsed?.cost ?? null,
  };
}));

for (const j of jobs) {
  const tag = j.videoId ? `id=${j.videoId} status=${j.initialStatus}` : `err=${(j.error ?? "").slice(0,80)}`;
  console.log(`  [${j.httpStatus}] ${j.model.padEnd(35)}  ${tag}`);
}

// ── 3. poll all running jobs in parallel until terminal or timeout ─
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT  = 8 * 60 * 1000;
console.log(`\n▶ Polling (${POLL_INTERVAL/1000}s interval, ${POLL_TIMEOUT/1000}s cap)...\n`);

await Promise.all(jobs.filter((j) => j.videoId).map(async (j) => {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > POLL_TIMEOUT) {
      j.finalStatus = "TIMEOUT";
      j.finalError = `Hit ${POLL_TIMEOUT/1000}s cap`;
      j.pollMs = Date.now() - t0;
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const r = await fetch(j.pollUrl, { headers: HEADERS });
      const data = await r.json();
      const status = data?.status ?? data?.data?.status;
      if (status === "completed" || status === "succeeded") {
        // URL is usually under data.output.video or data.video or similar
        j.finalStatus = status;
        j.finalUrl = data?.output?.video?.url ?? data?.video_url ?? data?.url ?? data?.output ?? data?.data?.output;
        j.cost = data?.cost ?? j.cost;
        j.pollMs = Date.now() - t0;
        return;
      }
      if (status === "failed" || status === "error" || data?.error) {
        j.finalStatus = status ?? "error";
        j.finalError = data?.error?.message ?? data?.failure_reason ?? JSON.stringify(data).slice(0, 200);
        j.pollMs = Date.now() - t0;
        return;
      }
      // still pending/processing — keep polling
    } catch (e) {
      // network blip — keep polling
    }
  }
}));

// ── 4. report ─────────────────────────────────────────────────────
console.log("\n━━━ RESULTS ━━━\n");
for (const j of jobs) {
  console.log(`◆ ${j.model}`);
  console.log(`    submit:        HTTP ${j.httpStatus} in ${j.submitMs}ms`);
  if (!j.videoId) {
    console.log(`    error:         ${j.error}`);
  } else {
    console.log(`    poll:          ${Math.round(j.pollMs/1000)}s → ${j.finalStatus}`);
    if (j.finalUrl) {
      const urlStr = typeof j.finalUrl === "string" ? j.finalUrl : JSON.stringify(j.finalUrl);
      console.log(`    video URL:     ${urlStr.slice(0, 200)}`);
    }
    if (j.finalError) console.log(`    error:         ${j.finalError.slice(0, 200)}`);
    if (j.cost) console.log(`    cost:          ${JSON.stringify(j.cost)}`);
  }
  console.log("");
}
