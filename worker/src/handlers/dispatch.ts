/**
 * Per-task-type dispatch — single chained `if` ladder that routes a
 * claimed job to its handler and returns the result patch to merge
 * into `finalPayload`. Extracted from worker/src/index.ts on
 * 2026-05-10 (per audit C-4-3). Behavior preserved exactly:
 *  - same task_type branches in the same order
 *  - same dynamic imports (keeps the main bundle slim — handlers are
 *    only loaded the first time their task type claims a slot)
 *  - same per-branch error messages ("job is missing user_id" etc.)
 *  - export_video keeps the legacy "merge only {finalUrl}" shape;
 *    every other branch spreads the full handler result.
 *  - unknown task types still write the "system_warning" log row.
 */
import type { Job } from "../types/job.js";
import { writeSystemLog } from "../lib/logger.js";

import { handleGenerateVideo } from "./generateVideo.js";
import { handleFinalizePhase } from "./handleFinalize.js";
import { handleExportVideo } from "./exportVideo.js";
import { handleRegenerateImage } from "./handleRegenerateImage.js";
import { handleRegenerateAudio } from "./handleRegenerateAudio.js";
import { handleCinematicVideo } from "./handleCinematicVideo.js";
import { handleCinematicAudio } from "./handleCinematicAudio.js";
import { handleCinematicImage } from "./handleCinematicImage.js";
import { handleUndoRegeneration } from "./handleUndoRegeneration.js";

/** Result patch to spread into the worker's finalPayload, or {} when
 *  there is nothing to merge. Never throws — handler errors propagate. */
export type DispatchPatch = Record<string, unknown>;

export async function dispatchJob(job: Job, signal?: AbortSignal): Promise<DispatchPatch> {
  if (job.task_type === 'generate_video' || (job.task_type as string) === 'generate_cinematic') {
    const scriptResult = await handleGenerateVideo(job.id, job.payload, job.user_id);
    // Merge result into finalPayload so both `payload` and `result` columns
    // carry the output — the frontend polls `payload` (old builds) or
    // `result` (new builds).
    if (scriptResult && typeof scriptResult === "object") {
      return scriptResult as unknown as DispatchPatch;
    }
    return {};
  }
  if (job.task_type === 'finalize_generation' as any) {
    return await handleFinalizePhase(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'export_video' as any) {
    const exportResult = await handleExportVideo(job.id, job.payload, job.user_id);
    return { finalUrl: exportResult.url };
  }
  if (job.task_type === 'regenerate_image' as any) {
    return await handleRegenerateImage(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'regenerate_audio' as any) {
    return await handleRegenerateAudio(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'voice_preview' as any) {
    const { handleVoicePreview } = await import("./handleVoicePreview.js");
    return await handleVoicePreview(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'clone_voice' as any) {
    // Fish Audio Instant Voice Cloning — receives a sample path,
    // transcodes to MP3 via ffmpeg, POSTs to /model with
    // enhance_audio_quality=true, persists the new voice id to
    // user_voices with provider='fish'. Browser polls this job
    // for the result.voiceId.
    if (!job.user_id) throw new Error("clone_voice job is missing user_id");
    const { handleCloneVoice } = await import("./handleCloneVoice.js");
    return await handleCloneVoice(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'rename_voice' as any) {
    // Friendly-name rename for a user's clone. PATCHes Fish's
    // /model/{id} title + description, then mirrors the change
    // into user_voices so MotionMax surfaces the new label
    // everywhere on next refetch.
    if (!job.user_id) throw new Error("rename_voice job is missing user_id");
    const { handleRenameVoice } = await import("./handleRenameVoice.js");
    return await handleRenameVoice(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'cinematic_video' as any) {
    return await handleCinematicVideo(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'cinematic_video_edit' as any) {
    // Text-prompt video edit via grok-imagine-video-edit. Replaces
    // the legacy "regen 2 scenes from new keyframes" path used after
    // a Nano Banana Pro image edit. Dynamic import keeps the main
    // bundle slim — handler is only loaded when an edit job claims
    // a slot.
    const { handleCinematicVideoEdit } = await import("./handleCinematicVideoEdit.js");
    return await handleCinematicVideoEdit(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'cinematic_audio' as any) {
    return await handleCinematicAudio(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'master_audio' as any) {
    // ONE continuous TTS track per generation for doc2video +
    // cinematic. Replaces N per-scene cinematic_audio jobs — cuts
    // Gemini quota burn from 15× to 1× and eliminates cross-scene
    // tonality jumps. Handler back-fills every scene's audioUrl
    // with the master URL so existing editor + export paths work.
    const { handleMasterAudio } = await import("./handleMasterAudio.js");
    return await handleMasterAudio(job.id, job.payload as any, job.user_id, signal) as unknown as DispatchPatch;
  }
  if (job.task_type === 'cinematic_image' as any) {
    return await handleCinematicImage(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'undo_regeneration' as any) {
    return await handleUndoRegeneration(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'generate_topics' as any) {
    // Wave B1 (Autopost UI redesign) — produces 15 video topic
    // ideas for the intake-form ScheduleBlock. The front-end
    // polls this job (1.5s interval) and reads `result.topics`.
    if (!job.user_id) throw new Error("generate_topics job is missing user_id");
    const { handleGenerateTopics } = await import("./handleGenerateTopics.js");
    return await handleGenerateTopics(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'autopost_render' as any) {
    // Autopost orchestrator — the cron tick (autopost_tick) and
    // user-driven Run-now (autopost_fire_now RPC) both insert
    // autopost_render jobs. Without this branch they would sit
    // pending forever. Walks the script→audio→images→[video]→
    // finalize→export pipeline in one long-running task,
    // returning finalUrl in result so autopost_on_video_completed
    // fans out publish/email/library based on delivery_method.
    if (!job.user_id) throw new Error("autopost_render job is missing user_id");
    const { handleAutopostRun } = await import("./autopost/handleAutopostRun.js");
    return await handleAutopostRun(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'autopost_rerender' as any) {
    // Re-render an EXISTING autopost project (same script, fresh
    // audio + images + videos + export). Triggered from the Run
    // History "Regenerate" button. Skips the script phase entirely
    // — the existing scene voiceovers/visualPrompts drive media
    // regeneration directly.
    if (!job.user_id) throw new Error("autopost_rerender job is missing user_id");
    const { handleAutopostRerender } = await import("./autopost/handleAutopostRerender.js");
    return await handleAutopostRerender(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }
  if (job.task_type === 'autopost_email_delivery' as any) {
    // Wave E (Autopost delivery modes) — when an autopost render
    // completes for a schedule with delivery_method='email', the
    // autopost_on_video_completed trigger queues this job. The
    // handler signs the rendered video URL and POSTs to Resend.
    if (!job.user_id) throw new Error("autopost_email_delivery job is missing user_id");
    const { handleAutopostEmailDelivery } = await import("./autopost/handleEmailDelivery.js");
    return await handleAutopostEmailDelivery(job.id, job.payload as any, job.user_id) as unknown as DispatchPatch;
  }

  // Unknown task type — log and return empty patch. Caller still
  // marks the job 'completed' so the frontend stops polling; this
  // matches the prior inline behavior.
  await writeSystemLog({
    jobId: job.id,
    userId: job.user_id,
    category: "system_warning",
    eventType: "unknown_task",
    message: `No handler for task type: ${job.task_type}`,
  });
  return {};
}
