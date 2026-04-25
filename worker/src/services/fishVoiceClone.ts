/**
 * Fish Audio voice cloning (Instant Voice Cloning via /model endpoint).
 *
 * The browser uploads a WebM sample to Supabase storage; the worker
 * downloads it, transcodes to MP3 via ffmpeg (Fish IVC accepts MP3
 * cleanly; WebM acceptance is undocumented and unreliable), and POSTs
 * a multipart form to https://api.fish.audio/model with the highest
 * quality knobs Fish exposes: enhance_audio_quality=true (their
 * built-in denoise + normalisation pass) and train_mode=fast.
 *
 * Returns the new model id which the audio router uses as
 * reference_id when generating TTS for this user's projects.
 *
 * See https://docs.fish.audio/developer-guide/best-practices/voice-cloning
 * for sample quality recommendations enforced upstream (10s minimum,
 * one speaker, low noise, ~hand-width mic distance).
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supabase } from "../lib/supabase.js";

interface CloneResult {
  voiceId: string;
  rawResponse: unknown;
}

/** Transcode an arbitrary input audio blob (WebM, M4A, MP4, WAV…) to
 *  44.1 kHz mono MP3 via ffmpeg. Fish IVC works best with consistent
 *  high-quality MP3 inputs; raw browser WebM gets rejected sporadically. */
async function transcodeToMp3(input: Buffer, inputExt: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "fish-clone-"));
  const inPath = join(dir, `in.${inputExt}`);
  const outPath = join(dir, "out.mp3");
  try {
    await writeFile(inPath, input);
    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i", inPath,
        "-vn",            // no video stream even if container has one
        "-ac", "1",       // mono
        "-ar", "44100",   // 44.1 kHz — Fish's default sample rate
        "-codec:a", "libmp3lame",
        "-q:a", "2",      // VBR quality 2 (~190 kbps) — high-quality reference sample
        outPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (b) => { stderr += b.toString(); });
      ff.on("error", reject);
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
      });
    });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pull the audio sample from Supabase storage. The edge function
 *  passes us a path inside the `voice_samples` bucket (e.g.
 *  `<userId>/<ts>-<name>.mp3`); we use service-role access to read
 *  it server-side regardless of the bucket's public/private setting. */
async function downloadSample(storagePath: string): Promise<{ bytes: Buffer; ext: string }> {
  const { data, error } = await supabase.storage
    .from("voice_samples")
    .download(storagePath);
  if (error || !data) throw new Error(`Failed to read sample: ${error?.message ?? "no data"}`);
  const arrayBuf = await data.arrayBuffer();
  // Best-effort extension detection from the path; ffmpeg uses it only
  // as a hint, the actual decoding is done by content sniffing.
  const ext = (storagePath.split(".").pop() || "webm").toLowerCase();
  return { bytes: Buffer.from(arrayBuf), ext };
}

export interface CloneOptions {
  storagePath: string;
  voiceName: string;
  description?: string;
  /** When provided, sent as the `texts` field — Fish uses it to align
   *  acoustic features to the spoken transcript and bumps clone fidelity
   *  noticeably. We don't always have this (recordings rarely match an
   *  exact prompt) so it's optional. */
  transcript?: string;
}

/** Clone a voice via Fish Audio Instant Voice Cloning.
 *  Returns the new model id (used as `reference_id` at TTS time). */
export async function cloneVoiceWithFish(
  opts: CloneOptions,
  apiKey: string,
): Promise<CloneResult> {
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY not configured");

  // 1. Pull + transcode
  const { bytes: rawBytes, ext } = await downloadSample(opts.storagePath);
  const mp3Bytes = await transcodeToMp3(rawBytes, ext);

  // 2. Build multipart body. Fetch supports FormData natively in
  //    Node 18+; Blob preserves binary integrity.
  const form = new FormData();
  form.append("title", opts.voiceName);
  form.append("type", "tts");
  form.append("train_mode", "fast");
  // enhance_audio_quality is Fish's built-in noise-reduction +
  // loudness-normalisation pass. There's no separate denoise
  // parameter; this flag IS the denoise.
  form.append("enhance_audio_quality", "true");
  form.append("visibility", "private");
  if (opts.description) form.append("description", opts.description);
  if (opts.transcript) form.append("texts", opts.transcript);
  form.append(
    "voices",
    new Blob([new Uint8Array(mp3Bytes)], { type: "audio/mpeg" }),
    `${opts.voiceName.replace(/[^a-z0-9]/gi, "_")}.mp3`,
  );

  // 3. Hit the API. POST /model returns ModelEntity { _id, ... }.
  const res = await fetch("https://api.fish.audio/model", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fish IVC ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as { _id?: string; id?: string };
  const voiceId = json._id || json.id;
  if (!voiceId) throw new Error(`Fish IVC: no id in response: ${JSON.stringify(json).slice(0, 200)}`);
  return { voiceId, rawResponse: json };
}

/** Delete a Fish-hosted voice. Idempotent — Fish returns 200 even when
 *  the model is already gone, so we don't surface "not found" errors. */
export async function deleteFishVoice(voiceId: string, apiKey: string): Promise<void> {
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY not configured");
  const res = await fetch(`https://api.fish.audio/model/${encodeURIComponent(voiceId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fish delete ${res.status}: ${body.slice(0, 200)}`);
  }
}
