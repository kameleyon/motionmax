#!/usr/bin/env node
/**
 * One-off PixVerse Lipsync probe.
 *
 * Submits a single prediction to pixverse/lipsync on Replicate to see
 * whether the model accepts your real motionmax content (168.5s audio +
 * matching exported video). Costs ~$0.06 if PixVerse accepts the
 * request and the prediction runs to completion, $0.00 if it rejects
 * during the submit/queue phase with a 4xx.
 *
 * Usage:
 *   REPLICATE_API_KEY=r8_xxx node scripts/test-pixverse-lipsync.mjs \
 *     <video-url> <audio-url>
 *
 * Output: prediction id + status transitions every 5s, then the final
 * `output` URL or an error message. Cancel with Ctrl-C — that does NOT
 * cancel the Replicate prediction itself (use the cancel URL printed at
 * submit time if you want to stop billing).
 */

const apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
if (!apiKey) {
  console.error("Missing REPLICATE_API_KEY env var. Grab it from Railway → motionmax worker → Variables.");
  process.exit(1);
}

const [videoUrl, audioUrl] = process.argv.slice(2);
if (!videoUrl || !audioUrl) {
  console.error("Usage: REPLICATE_API_KEY=r8_xxx node scripts/test-pixverse-lipsync.mjs <video-url> <audio-url>");
  console.error("");
  console.error("To get a real video URL: open any completed export in the editor, copy the player's src.");
  console.error("To get the master audio URL: SELECT master_audio_url FROM generations WHERE id = '<your-gen-id>';");
  process.exit(1);
}

const t0 = Date.now();
console.log("Submitting prediction to pixverse/lipsync...");

const submit = await fetch("https://api.replicate.com/v1/models/pixverse/lipsync/predictions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    input: { video: videoUrl, audio: audioUrl },
  }),
});

if (!submit.ok) {
  const err = await submit.text();
  console.error(`Submit failed (${submit.status}): ${err}`);
  console.error("If this is a duration/size constraint error, PixVerse can't handle this clip — confirms we should use sync/lipsync-2 instead.");
  process.exit(2);
}

const created = await submit.json();
console.log(`Submitted: ${created.id}`);
console.log(`Cancel URL (use to stop billing): ${created.urls?.cancel ?? "n/a"}`);

let lastStatus = "";
while (true) {
  await new Promise((r) => setTimeout(r, 5000));
  const poll = await fetch(`https://api.replicate.com/v1/predictions/${created.id}`, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!poll.ok) {
    console.error(`Poll failed: ${poll.status} ${await poll.text()}`);
    process.exit(3);
  }
  const body = await poll.json();
  if (body.status !== lastStatus) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[+${elapsed}s] status=${body.status}`);
    lastStatus = body.status;
  }
  if (body.status === "succeeded") {
    console.log("");
    console.log("✅ PixVerse accepted and completed your clip.");
    console.log(`   Output URL: ${typeof body.output === "string" ? body.output : JSON.stringify(body.output)}`);
    console.log(`   predict_time: ${body.metrics?.predict_time ?? "?"}s`);
    console.log(`   Total wall-clock: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log("");
    console.log("Verdict: PixVerse works for this content length. Worth switching from sync/lipsync-2.");
    process.exit(0);
  }
  if (body.status === "failed" || body.status === "canceled") {
    console.error(`❌ ${body.status}: ${body.error ?? "no reason given"}`);
    if (typeof body.error === "string" && /duration|length|long|seconds|size|too/i.test(body.error)) {
      console.error("");
      console.error("Verdict: PixVerse rejected this clip on a length/size constraint. Stick with sync/lipsync-2.");
    }
    process.exit(4);
  }
}
