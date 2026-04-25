import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production', tracesSampleRate: 0.1 });

import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { handleGenerateVideo } from "./handlers/generateVideo.js";
import { handleFinalizePhase } from "./handlers/handleFinalize.js";
import { handleExportVideo } from "./handlers/exportVideo.js";
import { handleRegenerateImage } from "./handlers/handleRegenerateImage.js";
import { handleRegenerateAudio } from "./handlers/handleRegenerateAudio.js";
import { handleCinematicVideo } from "./handlers/handleCinematicVideo.js";
import { handleCinematicAudio } from "./handlers/handleCinematicAudio.js";
import { handleCinematicImage } from "./handlers/handleCinematicImage.js";
import { handleUndoRegeneration } from "./handlers/handleUndoRegeneration.js";
import { writeSystemLog } from "./lib/logger.js";
import { wlog } from "./lib/workerLogger.js";
import { isTransientError, retryDelayMs } from "./lib/retryClassifier.js";
import { startHealthServer, stopHealthServer } from "./healthServer.js";

/* ---- Auto-tune concurrency based on system resources ---- */
import os from "os";
import fs from "fs";
import { randomUUID } from "crypto";

/**
 * Get the actual memory available to this process.
 * In containers (Docker/Render), os.totalmem() returns the HOST memory,
 * not the container's cgroup limit. We read the cgroup limit directly.
 */
function getContainerMemoryBytes(): number {
  const hostMem = os.totalmem();

  // Try cgroup v2 first (newer Linux kernels / Render)
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
    if (raw !== "max") {
      const limit = parseInt(raw, 10);
      if (limit > 0 && limit < hostMem) return limit;
    }
  } catch { /* not cgroup v2 */ }

  // Try cgroup v1
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf-8").trim();
    const limit = parseInt(raw, 10);
    // cgroup v1 returns a huge number (9223372036854771712) when unlimited
    if (limit > 0 && limit < hostMem) return limit;
  } catch { /* not cgroup v1 */ }

  // Fallback: host memory (non-containerized or Windows)
  return hostMem;
}

function detectOptimalConcurrency(): number {
  const envOverride = process.env.WORKER_CONCURRENCY;
  if (envOverride) return parseInt(envOverride, 10);

  const cpuCount = os.cpus().length;
  const hostMemMb = Math.round(os.totalmem() / 1048576);
  const containerMemMb = Math.round(getContainerMemoryBytes() / 1048576);

  // Use container memory (not host) for memory-based limit
  // Reserve 512MB for OS/Node.js overhead, use the rest for jobs
  const availableMemMb = Math.max(512, containerMemMb - 512);
  const byMemory = Math.floor(availableMemMb / 200);  // ~200MB per concurrent job
  const byCpu = cpuCount * 3;                           // conservative CPU multiplier
  const optimal = Math.max(4, Math.min(byCpu, byMemory, 20)); // floor 4, cap 20

  wlog.info("Auto-tuned concurrency", {
    optimal, cpus: cpuCount, hostRamMb: hostMemMb,
    containerRamMb: containerMemMb, availableMb: availableMemMb,
    byCpu, byMemory,
  });
  return optimal;
}

/* ---- Per-task-type worker pools ----
 * FFmpeg exports (export_video) are CPU+memory-bound and compete with AI API calls
 * if they share the same slot pool. Separate pools let each type scale independently.
 */
const activeExportJobs = new Set<string>(); // export_video — FFmpeg, CPU/memory-heavy
const activeLlmJobs    = new Set<string>(); // all other task types — AI APIs, network-bound

function isExportTask(taskType: string): boolean {
  return taskType === 'export_video';
}

function getActivePool(taskType: string): Set<string> {
  return isExportTask(taskType) ? activeExportJobs : activeLlmJobs;
}

function allActiveJobIds(): string[] {
  return [...activeExportJobs, ...activeLlmJobs];
}

function totalActiveJobs(): number {
  return activeExportJobs.size + activeLlmJobs.size;
}

const _totalSlots = detectOptimalConcurrency();

// FFmpeg is memory-heavy: allocate 25% of total slots, min 1.
// Remaining slots go to LLM/AI tasks (network-bound, can be more concurrent).
const MAX_EXPORT_SLOTS = process.env.WORKER_EXPORT_CONCURRENCY
  ? parseInt(process.env.WORKER_EXPORT_CONCURRENCY, 10)
  : Math.max(1, Math.floor(_totalSlots * 0.25));
const MAX_LLM_SLOTS = process.env.WORKER_LLM_CONCURRENCY
  ? parseInt(process.env.WORKER_LLM_CONCURRENCY, 10)
  : Math.max(2, _totalSlots - MAX_EXPORT_SLOTS);
const MAX_CONCURRENT_JOBS = MAX_EXPORT_SLOTS + MAX_LLM_SLOTS;

/* ---- Worker identity ---- */
// Unique per-process ID stamped onto every claimed job.
// Allows the startup diagnostic to scope resets to THIS worker's own rows
// rather than blindly touching rows owned by sibling replicas.
const WORKER_ID: string = `${os.hostname()}-${process.pid}-${randomUUID()}`;

/* ---- Queue depth monitoring ---- */
let queueDepthAlertThreshold = MAX_CONCURRENT_JOBS * 2; // alert when queue > 2x capacity
let lastQueueAlert = 0;
const QUEUE_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // don't spam alerts more than every 5 min

/* ---- Graceful shutdown state ---- */
let isShuttingDown = false;
let fallbackPollTimer: ReturnType<typeof setInterval> | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;
let lastPollAt: string | null = null;
let realtimeStatus: string = 'unknown';
let totalJobsProcessed = 0;
let totalJobsFailed = 0;

/** Maximum time (ms) to wait for active jobs to drain during shutdown. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT || "300000", 10); // 5 minutes

/* ---- Transient-error retry helpers ---- */
// isTransientError and retryDelayMs imported from ./lib/retryClassifier.js

const MAX_JOB_RETRIES = 3;

async function withTransientRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { jobId: string; maxAttempts?: number }
): Promise<T> {
  const max = opts.maxAttempts ?? MAX_JOB_RETRIES;
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;
      if (attempt >= max || !isTransientError(err)) throw err;
      const delay = retryDelayMs(attempt - 1); // 2s, 4s, 8s with jitter
      wlog.warn("Transient error — retrying", {
        jobId: opts.jobId, attempt, maxAttempts: max, delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/* ---- Credit refund helper ---- */
// 1 credit = 1 second. Multipliers: standard 1x, cinematic 5x, smartflow 0.5x
const LENGTH_SECONDS: Record<string, number> = { short: 150, brief: 280, presentation: 360 };
const PRODUCT_MULT: Record<string, number> = { doc2video: 1, smartflow: 0.5, cinematic: 5 };

function getCreditCost(projectType: string, length: string): number {
  const secs = LENGTH_SECONDS[length] || 150;
  const mult = PRODUCT_MULT[projectType] || 1;
  return Math.ceil(secs * mult);
}

async function refundCreditsOnFailure(job: Job) {
  if (!job.user_id) {
    console.log(`[Refund] Skipping refund for job ${job.id} - no user_id`);
    return;
  }

  try {
    const payload = job.payload || {};
    const projectType = payload.projectType || "doc2video";
    const length = payload.length || "brief";

    // Use the exact amount deducted upfront when available (stored in payload
    // by the edge function). Falls back to the formula estimate for legacy jobs
    // where the payload doesn't carry creditsDeducted.
    const creditsToRefund: number =
      typeof payload.creditsDeducted === "number" && payload.creditsDeducted > 0
        ? payload.creditsDeducted
        : getCreditCost(projectType, length);

    // Idempotency check: query credit_transactions for an existing refund row for
    // this job. Retried jobs transition back to 'processing' before failing again,
    // so a job-status check is unreliable — only a committed transaction record is.
    const refundDescription = `Refund for failed generation (job ${job.id})`;
    const { data: existingRefund, error: refundCheckError } = await supabase
      .from('credit_transactions')
      .select('id')
      .eq('user_id', job.user_id)
      .eq('transaction_type', 'refund')
      .eq('description', refundDescription)
      .limit(1)
      .maybeSingle();

    if (refundCheckError) {
      console.warn(`[Refund] Could not verify idempotency for job ${job.id}:`, refundCheckError.message);
      // Fall through and attempt the refund; the RPC handles balance safely.
    } else if (existingRefund) {
      console.warn(`[Refund] Refund already issued for job ${job.id} (tx ${existingRefund.id}) — skipping duplicate`);
      return;
    }

    console.log(`[Refund] Attempting to refund ${creditsToRefund} credits for user ${job.user_id} (job ${job.id}, type ${projectType}/${length})`);

    const { data: refundSuccess, error: rpcError } = await supabase.rpc(
      "refund_credits_securely",
      {
        p_user_id: job.user_id,
        p_amount: creditsToRefund,
        p_description: refundDescription,
      }
    );

    if (rpcError || !refundSuccess) {
      console.error(`[Refund] Failed to refund credits for user ${job.user_id}:`, rpcError?.message);
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_warning",
        eventType: "refund_failed",
        message: `Failed to refund ${creditsToRefund} credits for job ${job.id}`,
        details: { error: rpcError?.message }
      });
    } else {
      console.log(`[Refund] Successfully refunded ${creditsToRefund} credits for user ${job.user_id}`);
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_info",
        eventType: "credits_refunded",
        message: `Refunded ${creditsToRefund} credits for failed job ${job.id}`,
        details: { credits: creditsToRefund, projectType, length }
      });
    }
  } catch (err) {
    console.error(`[Refund] Exception while refunding credits for job ${job.id}:`, err);
  }
}

async function processJob(job: Job) {
  const pool = getActivePool(job.task_type);
  pool.add(job.id);

  // Tag Sentry scope with job context so all events within this job are correlated.
  const traceId: string | undefined = job.payload?.traceId;
  Sentry.withScope((scope) => {
    scope.setTag("jobId", job.id);
    scope.setTag("taskType", job.task_type);
    if (job.user_id) scope.setUser({ id: job.user_id });
    if (traceId) scope.setTag("traceId", traceId);
  });

  await writeSystemLog({
    jobId: job.id,
    projectId: job.project_id ?? undefined,
    userId: job.user_id,
    generationId: job.payload?.generation_id,
    category: "system_info",
    eventType: "job_started",
    message: `Worker picked up job ${job.id}`
  });

  let finalPayload = { ...job.payload };

  // Log bulk-op tag if present — payload._bulk = 'voice-apply-all' |
  // 'captions-apply' | 'motion-apply-all'. Editor uses this to flip
  // the project-wide lock UI; worker doesn't behave differently per
  // tag, but logging it makes per-batch debugging greppable. Unknown
  // payload fields are passed through untouched (handlers destructure
  // only what they need), so this is purely observational.
  const bulkTag = (job.payload as { _bulk?: string } | null)?._bulk;
  if (bulkTag) {
    console.log(`[Worker] Job ${job.id} (${job.task_type}) tagged _bulk=${bulkTag}`);
  }

  try {
    // Status already set to 'processing' by claim_pending_job RPC
    // Only update if job was recovered from startup diagnostic (not via atomic claim)
    if (job.status !== 'processing') {
      await supabase
        .from('video_generation_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', job.id);
    }

    await withTransientRetry(async (attempt) => {
      if (attempt > 0) {
        await writeSystemLog({
          jobId: job.id,
          projectId: job.project_id ?? undefined,
          userId: job.user_id,
          category: "system_info",
          eventType: "job_retry",
          message: `Retrying job ${job.id} (attempt ${attempt + 1}/${MAX_JOB_RETRIES}) after transient error`,
        });
      }

      if (job.task_type === 'generate_video' || (job.task_type as string) === 'generate_cinematic') {
        const scriptResult = await handleGenerateVideo(job.id, job.payload, job.user_id);
        // Merge result into finalPayload so both `payload` and `result` columns
        // carry the output — the frontend polls `payload` (old builds) or
        // `result` (new builds).
        if (scriptResult && typeof scriptResult === "object") {
          finalPayload = { ...finalPayload, ...scriptResult };
        }
      } else if (job.task_type === 'finalize_generation' as any) {
        const finalizeResult = await handleFinalizePhase(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...finalizeResult };
      } else if (job.task_type === 'export_video' as any) {
        const exportResult = await handleExportVideo(job.id, job.payload, job.user_id);
        finalPayload.finalUrl = exportResult.url;
      } else if (job.task_type === 'regenerate_image' as any) {
        const regenResult = await handleRegenerateImage(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...regenResult };
      } else if (job.task_type === 'regenerate_audio' as any) {
        const audioRegenResult = await handleRegenerateAudio(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...audioRegenResult };
      } else if (job.task_type === 'voice_preview' as any) {
        const { handleVoicePreview } = await import("./handlers/handleVoicePreview.js");
        const previewResult = await handleVoicePreview(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...previewResult };
      } else if (job.task_type === 'clone_voice' as any) {
        // Fish Audio Instant Voice Cloning — receives a sample path,
        // transcodes to MP3 via ffmpeg, POSTs to /model with
        // enhance_audio_quality=true, persists the new voice id to
        // user_voices with provider='fish'. Browser polls this job
        // for the result.voiceId.
        if (!job.user_id) throw new Error("clone_voice job is missing user_id");
        const { handleCloneVoice } = await import("./handlers/handleCloneVoice.js");
        const cloneResult = await handleCloneVoice(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...cloneResult };
      } else if (job.task_type === 'cinematic_video' as any) {
        const result = await handleCinematicVideo(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...result };
      } else if (job.task_type === 'cinematic_audio' as any) {
        const result = await handleCinematicAudio(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...result };
      } else if (job.task_type === 'master_audio' as any) {
        // ONE continuous TTS track per generation for doc2video +
        // cinematic. Replaces N per-scene cinematic_audio jobs — cuts
        // Gemini quota burn from 15× to 1× and eliminates cross-scene
        // tonality jumps. Handler back-fills every scene's audioUrl
        // with the master URL so existing editor + export paths work.
        const { handleMasterAudio } = await import("./handlers/handleMasterAudio.js");
        const result = await handleMasterAudio(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...result };
      } else if (job.task_type === 'cinematic_image' as any) {
        const result = await handleCinematicImage(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...result };
      } else if (job.task_type === 'undo_regeneration' as any) {
        const result = await handleUndoRegeneration(job.id, job.payload as any, job.user_id);
        finalPayload = { ...finalPayload, ...result };
      } else {
        await writeSystemLog({
          jobId: job.id,
          userId: job.user_id,
          category: "system_warning",
          eventType: "unknown_task",
          message: `No handler for task type: ${job.task_type}`
        });
      }
    }, { jobId: job.id });

    await writeSystemLog({
      jobId: job.id,
      projectId: job.project_id ?? undefined,
      userId: job.user_id,
      category: "system_info",
      eventType: "job_completed",
      message: `Worker successfully completed job ${job.id}`
    });

    // Strip restart bookkeeping before persisting
    const { _restartCount: _rc, ...cleanPayload } = finalPayload;

    const { error: completeError } = await (supabase as any)
      .from('video_generation_jobs')
      .update({
        status: 'completed',
        progress: 100,
        payload: cleanPayload,
        result: cleanPayload,       // also write result so pollWorkerJob always finds it
        updated_at: new Date().toISOString()
      })
      .eq('id', job.id);

    if (completeError) {
      console.error(`[Worker] Failed to mark job ${job.id} as completed:`, completeError.message);
      // Retry once — this is critical, otherwise the frontend polls forever
      await supabase
        .from('video_generation_jobs')
        .update({ status: 'completed', progress: 100, result: cleanPayload, updated_at: new Date().toISOString() })
        .eq('id', job.id);
    }

    totalJobsProcessed++;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Log the failure — wrapped in try/catch to guarantee we reach the status update
    try {
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_error",
        eventType: "job_failed",
        message: `Worker failed processing job ${job.id}: ${errorMsg}`,
        details: { stack: error instanceof Error ? error.stack : null }
      });
    } catch (logErr) {
      console.error(`[Worker] Failed to write failure log for ${job.id}:`, logErr);
    }

    // Refund credits for failed generation
    try {
      await refundCreditsOnFailure(job);
    } catch (refundErr) {
      console.error(`[Worker] Refund failed for ${job.id}:`, refundErr);
    }

    // CRITICAL: Mark the job as failed — if this doesn't happen, the frontend polls forever
    const { error: failError } = await supabase
      .from('video_generation_jobs')
      .update({
        status: 'failed',
        error_message: errorMsg,
        updated_at: new Date().toISOString()
      })
      .eq('id', job.id);

    if (failError) {
      console.error(`[Worker] CRITICAL: Failed to mark job ${job.id} as failed:`, failError.message);
      // Last resort retry
      await supabase
        .from('video_generation_jobs')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .then(
          () => {},
          (retryErr: unknown) => {
            wlog.error("CRITICAL: Last-resort mark-failed also failed", { jobId: job.id, error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
            Sentry.captureException(retryErr, { tags: { jobId: job.id, phase: "mark-failed-retry" } });
          },
        );
    }

    // Move to dead-letter queue so permanently-failed jobs can be triaged
    // separately without clogging the active job table.
    supabase
      .from("dead_letter_jobs")
      .insert({
        source_job_id: job.id,
        task_type: job.task_type,
        payload: job.payload,
        error_message: errorMsg,
        attempts: (job.payload?._restartCount ?? 0) + 1,
        user_id: job.user_id ?? null,
        project_id: job.project_id ?? null,
        worker_id: WORKER_ID,
      })
      .then(() => {}, (dlqErr: unknown) => {
        wlog.warn("Dead-letter insert failed", { jobId: job.id, error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr) });
      });

    totalJobsFailed++;
  } finally {
    pool.delete(job.id);
  }
}

let pollCount = 0;

async function pollQueue() {
  // Do not pick up new jobs if shutting down
  if (isShuttingDown) return;

  pollCount++;
  try {
    const exportAvailable = MAX_EXPORT_SLOTS - activeExportJobs.size;
    const llmAvailable    = MAX_LLM_SLOTS    - activeLlmJobs.size;

    if (exportAvailable <= 0 && llmAvailable <= 0) return;

    const claimedJobs: any[] = [];

    // Claim export jobs first into their dedicated slots
    if (exportAvailable > 0) {
      const { data: exportData, error: exportError } = await supabase.rpc('claim_pending_job', {
        p_task_type: 'export_video',
        p_exclude_task_type: null,
        p_limit: exportAvailable,
        p_worker_id: WORKER_ID,
      });

      if (exportError) {
        console.error("[Worker] Claim export job error:", exportError.code, exportError.message);
      } else if (exportData && exportData.length > 0) {
        claimedJobs.push(...exportData);
      }
    }

    // Claim LLM/AI jobs into their separate slots
    if (llmAvailable > 0) {
      const { data: genData, error: genError } = await supabase.rpc('claim_pending_job', {
        p_task_type: null,
        p_exclude_task_type: 'export_video',
        p_limit: llmAvailable,
        p_worker_id: WORKER_ID,
      });

      if (genError) {
        console.error("[Worker] Claim gen job error:", genError.code, genError.message);
      } else if (genData && genData.length > 0) {
        claimedJobs.push(...genData);
      }
    }

    lastPollAt = new Date().toISOString();

    // Queue depth monitoring
    if (claimedJobs.length > 0) {
      const { count: totalPending } = await supabase
        .from('video_generation_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');

      if ((totalPending ?? 0) > queueDepthAlertThreshold && Date.now() - lastQueueAlert > QUEUE_ALERT_COOLDOWN_MS) {
        lastQueueAlert = Date.now();
        const mem = process.memoryUsage();
        console.warn(
          `[Worker] ⚠️ QUEUE DEPTH ALERT: ${totalPending} pending jobs (threshold: ${queueDepthAlertThreshold}), ` +
          `active: export=${activeExportJobs.size}/${MAX_EXPORT_SLOTS} llm=${activeLlmJobs.size}/${MAX_LLM_SLOTS}, ` +
          `RSS: ${Math.round(mem.rss / 1048576)}MB`
        );

        const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL;
        if (alertWebhookUrl) {
          fetch(alertWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: `MotionMax queue depth alert: ${totalPending} jobs pending`,
              queue_depth: totalPending,
            }),
          }).catch(() => {
            // Silently ignore webhook failures — never let an alert break the worker
          });
        }

        writeSystemLog({
          category: "system_warning",
          eventType: "queue_depth_alert",
          message: `Queue depth ${totalPending} exceeds threshold ${queueDepthAlertThreshold} — consider scaling workers`,
          details: {
            pendingJobs: totalPending,
            activeExportJobs: activeExportJobs.size,
            activeLlmJobs: activeLlmJobs.size,
            maxExportSlots: MAX_EXPORT_SLOTS,
            maxLlmSlots: MAX_LLM_SLOTS,
            rssMb: Math.round(mem.rss / 1048576),
            cpuCount: os.cpus().length,
            totalMemMb: Math.round(os.totalmem() / 1048576),
          },
        }).catch((err) => { console.warn('[Worker] background log failed:', (err as Error).message); });
      }
    }

    const shouldLog = pollCount % 12 === 1 || claimedJobs.length > 0;
    if (shouldLog) {
      console.log(
        `[Worker] Poll #${pollCount}: claimed: ${claimedJobs.length}, ` +
        `active: export=${activeExportJobs.size}/${MAX_EXPORT_SLOTS} llm=${activeLlmJobs.size}/${MAX_LLM_SLOTS}`
      );
    }

    for (const job of claimedJobs) {
      if (activeExportJobs.has(job.id) || activeLlmJobs.has(job.id)) continue;
      console.log(`[Worker] Claimed job ${job.id} (type: ${job.task_type})`);
      // Fire and forget — job is already marked 'processing' by the RPC
      Promise.race([
        processJob(job as Job),
        new Promise<void>((_, reject) => {
          const timeoutMs = getJobTimeoutMs(job.task_type);
          setTimeout(
            () => reject(new Error(`Job ${job.id} (${job.task_type}) exceeded hard timeout of ${timeoutMs / 60000} min`)),
            timeoutMs
          );
        }),
      ]).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Worker] Job ${job.id} failed or timed out: ${errMsg}`);
        Sentry.captureException(err instanceof Error ? err : new Error(errMsg));
        // Ensure DB is updated and slot freed — processJob may still be running
        const pool = getActivePool(job.task_type);
        if (pool.has(job.id)) {
          pool.delete(job.id);
          await supabase.from('video_generation_jobs').update({
            status: 'failed',
            error_message: errMsg,
            updated_at: new Date().toISOString(),
          }).eq('id', job.id);
        }
      });
    }
  } catch (err) {
    console.error("[Worker] Polling exception:", err);
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

// Fallback poll every 30s — handles missed realtime events and reconnection gaps.
const FALLBACK_POLL_INTERVAL_MS = 30_000;

// Per-task-type hard timeouts. Export jobs run ffmpeg (CPU-bound, can be long);
// LLM/API jobs should fail fast if a provider hangs.
const EXPORT_JOB_TIMEOUT_MS  = parseInt(process.env.EXPORT_JOB_TIMEOUT_MS  || "5400000", 10); // 90 min
const LLM_JOB_TIMEOUT_MS     = parseInt(process.env.LLM_JOB_TIMEOUT_MS     || "900000",  10); // 15 min
const JOB_TIMEOUT_MS         = parseInt(process.env.JOB_TIMEOUT_MS          || "5400000", 10); // legacy override

function getJobTimeoutMs(taskType: string): number {
  if (process.env.JOB_TIMEOUT_MS) return JOB_TIMEOUT_MS; // honour explicit override
  return isExportTask(taskType) ? EXPORT_JOB_TIMEOUT_MS : LLM_JOB_TIMEOUT_MS;
}

const MAX_RESTART_RETRIES = 3;

/** Cooldown (ms) before first poll after recovering orphaned jobs.
 *  Prevents the crash-restart-pick-up-crash loop. */
const STARTUP_COOLDOWN_MS = 10_000;

/** Run once at startup to verify DB connectivity and rescue orphaned jobs.
 *  Tracks retries via payload._restartCount — after 3 restarts, marks as failed.
 *  Returns true if orphaned jobs were recovered (triggers cooldown). */
async function startupDiagnostic(): Promise<boolean> {
  let recoveredOrphans = false;
  try {
    const { count, error } = await supabase
      .from("video_generation_jobs")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[Worker] ❌ Startup diagnostic FAILED — cannot read video_generation_jobs:", error.code, error.message);
      return false;
    }
    console.log(`[Worker] ✅ Startup diagnostic OK — video_generation_jobs has ${count ?? 0} total row(s)`);

    // Find processing jobs that are safe to reclaim:
    //   (a) rows this exact worker_id previously claimed — same process restarting, or
    //   (b) rows with no worker_id stamp that are >10 min old (genuinely stale / pre-migration rows)
    // This avoids touching rows actively held by sibling replicas.
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, payload, created_at, updated_at")
      .eq("status", "processing")
      .or(`worker_id.eq.${WORKER_ID},and(worker_id.is.null,updated_at.lt.${staleThreshold})`)
      .order("created_at", { ascending: true });

    if (processingRows && processingRows.length > 0) {
      recoveredOrphans = true;
      for (const row of processingRows as any[]) {
        const payload = (row.payload && typeof row.payload === "object") ? row.payload : {};
        const restartCount = (typeof payload._restartCount === "number" ? payload._restartCount : 0) + 1;

        if (restartCount > MAX_RESTART_RETRIES) {
          // Too many restarts — mark as failed to break the loop
          console.error(`[Worker] 🛑 Job ${row.id} exceeded ${MAX_RESTART_RETRIES} restart retries → marking FAILED`);
          await supabase
            .from("video_generation_jobs")
            .update({
              status: "failed",
              error_message: `Export failed after ${MAX_RESTART_RETRIES} worker restarts. The video may be too large for the current server. Please retry or try a shorter video.`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        } else {
          // Reset to pending with incremented restart counter
          console.warn(`[Worker] ⚠️  Orphaned job: ${row.id} (${row.task_type}) restart #${restartCount} → resetting to pending`);
          await supabase
            .from("video_generation_jobs")
            .update({
              status: "pending",
              progress: 0,
              error_message: null,
              payload: { ...payload, _restartCount: restartCount },
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        }
      }
    }

    // Show pending jobs remaining after cleanup
    const { data: pendingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, status, task_type, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(5);

    if (pendingRows && pendingRows.length > 0) {
      console.log(`[Worker] 📋 ${pendingRows.length} job(s) queued:`,
        pendingRows.map((r: any) => ({ id: r.id, task_type: r.task_type, status: r.status }))
      );
    } else {
      console.log("[Worker] 📋 No pending jobs at startup.");
    }
  } catch (err) {
    console.error("[Worker] ❌ Startup diagnostic exception:", err);
  }
  return recoveredOrphans;
}

/** Subscribe to Supabase Realtime so new pending jobs trigger an immediate poll
 *  rather than waiting for the 30s fallback interval. */
function subscribeToQueue() {
  realtimeChannel = supabase
    .channel('worker-job-queue')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'video_generation_jobs', filter: 'status=eq.pending' },
      () => { pollQueue(); }
    )
    .on(
      'postgres_changes',
      // Catches orphan resets (processing → pending) and manual re-queues
      { event: 'UPDATE', schema: 'public', table: 'video_generation_jobs', filter: 'status=eq.pending' },
      () => { pollQueue(); }
    )
    .subscribe((status, err) => {
      realtimeStatus = status;
      if (status === 'SUBSCRIBED') {
        console.log('[Worker] ✅ Realtime channel subscribed — instant job pickup active');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Worker] ⚠️  Realtime channel ${status}${err ? ': ' + err : ''} — fallback poll covers gap`);
      } else if (status === 'CLOSED') {
        console.log('[Worker] Realtime channel closed');
      }
    });
}

/* ---- Graceful shutdown ---- */

/**
 * Initiate graceful shutdown.
 * 1. Stop accepting new jobs (isShuttingDown = true)
 * 2. Unsubscribe realtime channel and stop fallback poll
 * 3. Wait for all active jobs to finish (with timeout)
 * 4. Close health server
 * 5. Exit
 */
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log(`[Worker] Already shutting down — ignoring duplicate ${signal}`);
    return;
  }

  isShuttingDown = true;
  const activeCount = totalActiveJobs();
  console.log(`[Worker] 🛑 Received ${signal} — initiating graceful shutdown`);
  console.log(`[Worker] Active jobs: ${activeCount} — will wait up to ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s for them to finish`);

  // Stop all job intake
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }

  await writeSystemLog({
    category: "system_info",
    eventType: "worker_shutdown_started",
    message: `Graceful shutdown initiated by ${signal} — ${activeCount} active job(s)`,
    details: { signal, activeJobCount: activeCount, activeJobIds: allActiveJobIds() },
  });

  // Wait for active jobs to drain
  if (totalActiveJobs() > 0) {
    const drainStart = Date.now();
    const DRAIN_CHECK_INTERVAL = 2000;

    await new Promise<void>((resolve) => {
      const checkDrained = () => {
        const elapsed = Date.now() - drainStart;

        if (totalActiveJobs() === 0) {
          console.log(`[Worker] ✅ All active jobs drained in ${Math.round(elapsed / 1000)}s`);
          resolve();
          return;
        }

        if (elapsed >= SHUTDOWN_DRAIN_TIMEOUT_MS) {
          const stillActive = allActiveJobIds();
          console.error(
            `[Worker] ⚠️  Shutdown drain timeout after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s — ` +
            `${stillActive.length} job(s) still active: ${stillActive.join(", ")}. ` +
            `Leaving as 'processing' — startup diagnostic will re-queue on next start.`
          );
          // Jobs are idempotent: the startup diagnostic in startupDiagnostic() already
          // rescues orphaned 'processing' rows and resets them to 'pending' on the next
          // startup. Resetting here would cause duplicate work if the job handler is
          // mid-execution and the new worker picks it up immediately.
          resolve();
          return;
        }

        console.log(
          `[Worker] Waiting for ${totalActiveJobs()} active job(s) to finish... ` +
          `(${Math.round(elapsed / 1000)}s / ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s)`
        );
        setTimeout(checkDrained, DRAIN_CHECK_INTERVAL);
      };

      checkDrained();
    });
  }

  // Close health server
  await stopHealthServer();

  await writeSystemLog({
    category: "system_info",
    eventType: "worker_shutdown_complete",
    message: `Worker shutdown complete — processed ${totalJobsProcessed} jobs, ${totalJobsFailed} failed`,
    details: { totalJobsProcessed, totalJobsFailed },
  });

  console.log(`[Worker] 👋 Shutdown complete. Total: ${totalJobsProcessed} processed, ${totalJobsFailed} failed.`);
  process.exit(0);
}

/* ---- Signal handlers for graceful shutdown ---- */
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Intentional crash: capture to Sentry then exit so Render restarts the process.
// Keeping the process alive after uncaught errors risks processing jobs in a corrupt state.
process.on("uncaughtException", (err: Error) => {
  console.error("[Worker] 💥 Uncaught exception — marking jobs failed and exiting:", err.message);
  Sentry.captureException(err);
  // Mark this worker's in-flight jobs as failed so they are not orphaned.
  // Scope to WORKER_ID so sibling replicas' rows are not touched.
  // Fire-and-forget: do not await — we must exit promptly so the orchestrator can restart.
  supabase
    .from("video_generation_jobs")
    .update({ status: "failed", error_message: "Worker process crashed" })
    .eq("status", "processing")
    .eq("worker_id", WORKER_ID)
    .then(() => process.exit(1), () => process.exit(1));
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[Worker] 💥 Unhandled rejection — marking jobs failed and exiting:", reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  Sentry.captureException(err);
  // Mark this worker's in-flight jobs as failed so they are not orphaned.
  supabase
    .from("video_generation_jobs")
    .update({ status: "failed", error_message: "Worker process crashed" })
    .eq("status", "processing")
    .eq("worker_id", WORKER_ID)
    .then(() => process.exit(1), () => process.exit(1));
});

/**
 * Mask an API key for safe logging.
 * Only reveals total length and last 4 chars; never prints leading characters
 * to avoid accidental partial-key exposure in log aggregation services.
 */
function maskKey(key: string | undefined): string {
  if (!key) return "(NOT SET)";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "(EMPTY)";
  if (trimmed !== key) return `⚠️ HAS WHITESPACE — len=${trimmed.length} (trimmed)`;
  const tail = trimmed.length > 4 ? trimmed.substring(trimmed.length - 4) : "****";
  return `[SET, ${trimmed.length} chars, …${tail}]`;
}

/* ---- Start health server ---- */
const workerStartedAt = Date.now();

startHealthServer(() => ({
  activeJobs: totalActiveJobs(),
  activeExportJobs: activeExportJobs.size,
  activeLlmJobs: activeLlmJobs.size,
  maxExportSlots: MAX_EXPORT_SLOTS,
  maxLlmSlots: MAX_LLM_SLOTS,
  maxConcurrentJobs: MAX_CONCURRENT_JOBS,
  accepting: !isShuttingDown,
  uptimeSeconds: Math.round((Date.now() - workerStartedAt) / 1000),
  lastPollAt,
  realtimeStatus,
  pollStaleThresholdMs: FALLBACK_POLL_INTERVAL_MS * 3,
  totalJobsProcessed,
  totalJobsFailed,
}));

console.log(
  `[Worker] MotionMax Render Worker started. ` +
  `Slots: export=${MAX_EXPORT_SLOTS} llm=${MAX_LLM_SLOTS} total=${MAX_CONCURRENT_JOBS}. ` +
  `Realtime + ${FALLBACK_POLL_INTERVAL_MS / 1000}s fallback poll.`
);
// Comprehensive startup banner — every external provider the worker
// can talk to. Missing keys are surfaced here at boot instead of as
// runtime throws inside a handler 5 minutes into a generation. We
// don't EXIT on missing keys (some are optional / used only by
// specific project types) — just log a warning so deploy logs make
// the gap obvious.
const PROVIDER_KEYS: Array<[string, string, 'required' | 'optional']> = [
  ['HYPEREAL_API_KEY',     'Hypereal (image, ASR, video, edit)', 'required'],
  ['REPLICATE_API_KEY',    'Replicate (fallback image, audio)',   'required'],
  ['OPENROUTER_API_KEY',   'OpenRouter (LLM script)',             'required'],
  ['ELEVENLABS_API_KEY',   'ElevenLabs TTS',                      'optional'],
  ['SMALLEST_API_KEY',     'Smallest.ai TTS',                     'optional'],
  ['GEMINI_API_KEY',       'Gemini Flash TTS',                    'optional'],
  ['LYRIA_API_KEY',        'Lyria music generation',              'optional'],
  ['LTX_API_KEY',          'LTX video',                           'optional'],
  ['QWEN3_API_KEY',        'Qwen3 TTS',                           'optional'],
  ['FISH_AUDIO_API_KEY',   'Fish Audio TTS',                      'optional'],
  ['LEMONFOX_API_KEY',     'Lemonfox TTS',                        'optional'],
];
let missingRequired = 0;
console.log(`[Worker] ── Provider key check ────────────────────────`);
for (const [envName, label, requirement] of PROVIDER_KEYS) {
  const key = process.env[envName];
  const status = key ? `🔑 ${maskKey(key)}` : (requirement === 'required' ? '❌ MISSING (required)' : '○ not set (optional)');
  if (!key && requirement === 'required') missingRequired++;
  console.log(`[Worker]   ${envName.padEnd(22)} ${label.padEnd(40)} ${status}`);
}
console.log(`[Worker] ──────────────────────────────────────────────`);
if (missingRequired > 0) {
  console.warn(`[Worker] ⚠ ${missingRequired} REQUIRED provider key(s) missing — generations will fail until these are set.`);
}

startupDiagnostic().then((hadOrphans) => {
  const startPolling = () => {
    subscribeToQueue();
    pollQueue();
    fallbackPollTimer = setInterval(pollQueue, FALLBACK_POLL_INTERVAL_MS);
  };

  if (hadOrphans) {
    console.log(`[Worker] ⏳ Cooldown ${STARTUP_COOLDOWN_MS / 1000}s before first poll (orphans recovered)`);
    setTimeout(startPolling, STARTUP_COOLDOWN_MS);
  } else {
    startPolling();
  }
});
