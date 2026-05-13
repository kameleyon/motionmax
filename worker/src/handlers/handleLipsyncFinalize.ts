/**
 * lipsync_finalize handler — post-generation lipsync pass.
 *
 * Inputs (from job.payload):
 *   - generationId           : generations.id
 *   - sourceVideoUrl         : the already-exported MP4 (Supabase signed URL)
 *   - audioUrl               : generations.master_audio_url
 *   - model? 'lipsync-2'|'lipsync-2-pro'  (defaults to lipsync-2)
 *   - creditsDeducted        : exact credit amount to refund on failure
 *
 * Effects:
 *   1. Mark generations.lipsync_status = 'processing'.
 *   2. POST → Sync Labs, poll until COMPLETED (≤ 10 min).
 *   3. Download the synced MP4 → re-upload to Supabase storage so we
 *      don't depend on Sync Labs' hosted URL TTL.
 *   4. Write lipsync_video_url + success metadata.
 *   5. On any failure → mark lipsync_status='failed' + refund credits.
 *      Original final video is untouched.
 */

import { supabase } from "../lib/supabase.js";
import { writeSystemLog } from "../lib/logger.js";
import { audit, auditError } from "../lib/audit.js";
import { generateLipsync, type LipsyncModel } from "../services/replicateLipsync.js";
import { v4 as uuidv4 } from "uuid";

interface LipsyncFinalizePayload {
  generationId: string;
  sourceVideoUrl: string;
  audioUrl: string;
  model?: LipsyncModel;
  creditsDeducted?: number;
}

export async function handleLipsyncFinalize(
  jobId: string,
  payload: LipsyncFinalizePayload,
  userId?: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; lipsyncVideoUrl: string; provider: string }> {
  const { generationId } = payload;

  try {
    return await _runLipsyncFinalize(jobId, payload, userId, signal);
  } catch (err) {
    await auditError("lipsync.failed", err, {
      jobId, userId, generationId,
      details: { phase: "lipsync_finalize" },
    });
    // Stamp the generations row so the editor surfaces the failure
    // immediately. The outer worker catch handles the actual credit
    // refund via refundCreditsOnFailure(job) — it reads payload.
    // creditsDeducted with idempotency against credit_transactions
    // so we don't double-refund. We do NOT call refund directly here.
    await markLipsyncFailed(generationId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function _runLipsyncFinalize(
  jobId: string,
  payload: LipsyncFinalizePayload,
  userId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ success: boolean; lipsyncVideoUrl: string; provider: string }> {
  const { generationId, sourceVideoUrl, audioUrl, model, creditsDeducted } = payload;

  if (!sourceVideoUrl) throw new Error("lipsync_finalize: missing sourceVideoUrl");
  if (!audioUrl) throw new Error("lipsync_finalize: missing audioUrl");

  await writeSystemLog({
    jobId,
    userId,
    generationId,
    category: "system_info",
    eventType: "lipsync_started",
    message: `Lipsync started (model=${model ?? "lipsync-2"})`,
  });

  await supabase
    .from("generations")
    .update({ lipsync_status: "processing", lipsync_provider: "replicate", lipsync_model: `kwaivgi/${model ?? "kling-lip-sync"}` })
    .eq("id", generationId);

  // ── 1. Call Sync Labs ────────────────────────────────────────────
  const result = await generateLipsync({
    videoUrl: sourceVideoUrl,
    audioUrl,
    model,
    userId: userId ?? null,
    generationId,
    signal,
  });

  if (!result.videoUrl) {
    await markLipsyncFailed(generationId, result.error ?? "Sync Labs returned no URL");
    throw new Error(result.error ?? "Sync Labs lipsync failed");
  }
  void creditsDeducted;

  // ── 2. Re-host the synced video on our storage ───────────────────
  // Sync Labs URLs have a TTL; copying to Supabase makes the asset
  // permanent and stays inside our existing CSP rules.
  const finalUrl = await rehostToSupabase(result.videoUrl, generationId, signal);

  // ── 3. Mark generation success ───────────────────────────────────
  await supabase
    .from("generations")
    .update({
      lipsync_video_url: finalUrl,
      lipsync_status: "success",
      lipsync_completed_at: new Date().toISOString(),
      lipsync_error: null,
    })
    .eq("id", generationId);

  await writeSystemLog({
    jobId,
    userId,
    generationId,
    category: "system_info",
    eventType: "lipsync_completed",
    message: `Lipsync complete — ${result.durationSeconds ?? "?"}s output via ${result.provider}/${result.model}`,
  });

  await audit("lipsync.completed", {
    jobId, userId, generationId,
    message: `Lipsync video ready`,
    details: { provider: result.provider, model: result.model, durationSeconds: result.durationSeconds },
  });

  return { success: true, lipsyncVideoUrl: finalUrl, provider: `${result.provider}/${result.model}` };
}

/** Copy the Sync Labs output into our own `video` bucket. */
async function rehostToSupabase(
  syncLabsUrl: string,
  generationId: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await fetch(syncLabsUrl, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch Sync Labs output: ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());

  const fileName = `lipsync_${generationId}_${Date.now()}_${uuidv4().slice(0, 8)}.mp4`;
  const filePath = `${generationId}/${fileName}`;

  const { error: upErr } = await supabase.storage
    .from("video")
    .upload(filePath, buf, { contentType: "video/mp4", upsert: true });
  if (upErr) throw new Error(`Lipsync upload failed: ${upErr.message}`);

  const { data: signed, error: signErr } = await supabase.storage
    .from("video")
    .createSignedUrl(filePath, 60 * 60 * 24 * 365); // 1 year
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Lipsync signed URL failed: ${signErr?.message ?? "unknown"}`);
  }
  return signed.signedUrl;
}

async function markLipsyncFailed(generationId: string, error: string): Promise<void> {
  await supabase
    .from("generations")
    .update({
      lipsync_status: "failed",
      lipsync_error: error.substring(0, 500),
      lipsync_completed_at: new Date().toISOString(),
    })
    .eq("id", generationId);
}
