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
import { startHealthServer, stopHealthServer } from "./healthServer.js";

/* ---- Auto-tune concurrency based on system resources ---- */
import os from "os";
import fs from "fs";

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

  console.log(
    `[Worker] Auto-tuned concurrency: ${optimal} ` +
    `(CPUs=${cpuCount}, hostRAM=${hostMemMb}MB, containerRAM=${containerMemMb}MB, ` +
    `availableForJobs=${availableMemMb}MB, byCPU=${byCpu}, byMem=${byMemory})`
  );
  return optimal;
}

const activeJobs = new Set<string>();
const MAX_CONCURRENT_JOBS = detectOptimalConcurrency();

/* ---- Queue depth monitoring ---- */
let queueDepthAlertThreshold = MAX_CONCURRENT_JOBS * 2; // alert when queue > 2x capacity
let lastQueueAlert = 0;
const QUEUE_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // don't spam alerts more than every 5 min

/* ---- Graceful shutdown state ---- */
let isShuttingDown = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollAt: string | null = null;
let totalJobsProcessed = 0;
let totalJobsFailed = 0;

/** Maximum time (ms) to wait for active jobs to drain during shutdown. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_DRAIN_TIMEOUT || "300000", 10); // 5 minutes

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

    // Calculate credits to refund (same formula as deduction)
    const creditsToRefund = getCreditCost(projectType, length);

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
  activeJobs.add(job.id);

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

  try {
    // Status already set to 'processing' by claim_pending_job RPC
    // Only update if job was recovered from startup diagnostic (not via atomic claim)
    if (job.status !== 'processing') {
      await supabase
        .from('video_generation_jobs')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', job.id);
    }

    if (job.task_type === 'generate_video') {
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
    } else if (job.task_type === 'cinematic_video' as any) {
      const result = await handleCinematicVideo(job.id, job.payload as any, job.user_id);
      finalPayload = { ...finalPayload, ...result };
    } else if (job.task_type === 'cinematic_audio' as any) {
      const result = await handleCinematicAudio(job.id, job.payload as any, job.user_id);
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
        .then(() => {}, () => {});
    }

    totalJobsFailed++;
  } finally {
    activeJobs.delete(job.id);
  }
}

let pollCount = 0;

async function pollQueue() {
  // Do not pick up new jobs if shutting down
  if (isShuttingDown) return;

  pollCount++;
  try {
    const availableSlots = MAX_CONCURRENT_JOBS - activeJobs.size;
    if (availableSlots <= 0) return;

    const claimedJobs: any[] = [];

    // Batch claim: p_limit requests up to availableSlots jobs in one atomic RPC call
    // Claim export jobs first (priority)
    const { data: exportData, error: exportError } = await supabase.rpc('claim_pending_job', {
      p_task_type: 'export_video',
      p_exclude_task_type: null,
      p_limit: availableSlots,
    });

    if (exportError) {
      console.error("[Worker] Claim export job error:", exportError.code, exportError.message);
    } else if (exportData && exportData.length > 0) {
      claimedJobs.push(...exportData);
    }

    // Claim generation jobs with remaining slots
    const remainingSlots = availableSlots - claimedJobs.length;
    if (remainingSlots > 0) {
      const { data: genData, error: genError } = await supabase.rpc('claim_pending_job', {
        p_task_type: null,
        p_exclude_task_type: 'export_video',
        p_limit: remainingSlots,
      });

      if (genError) {
        console.error("[Worker] Claim gen job error:", genError.code, genError.message);
      } else if (genData && genData.length > 0) {
        claimedJobs.push(...genData);
      }
    }

    lastPollAt = new Date().toISOString();

    // Queue depth monitoring (keep existing logic but use claimed count)
    if (claimedJobs.length > 0) {
      // Check pending count for alerting
      const { count: totalPending } = await supabase
        .from('video_generation_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');

      if ((totalPending ?? 0) > queueDepthAlertThreshold && Date.now() - lastQueueAlert > QUEUE_ALERT_COOLDOWN_MS) {
        lastQueueAlert = Date.now();
        const mem = process.memoryUsage();
        console.warn(
          `[Worker] ⚠️ QUEUE DEPTH ALERT: ${totalPending} pending jobs (threshold: ${queueDepthAlertThreshold}), ` +
          `active: ${activeJobs.size}/${MAX_CONCURRENT_JOBS}, RSS: ${Math.round(mem.rss / 1048576)}MB`
        );

        // Fire webhook notification if configured (Slack, PagerDuty, etc.)
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
            activeJobs: activeJobs.size,
            maxConcurrent: MAX_CONCURRENT_JOBS,
            rssMb: Math.round(mem.rss / 1048576),
            cpuCount: os.cpus().length,
            totalMemMb: Math.round(os.totalmem() / 1048576),
          },
        }).catch((err) => { console.warn('[Worker] background log failed:', (err as Error).message); });
      }
    }

    const shouldLog = pollCount % 12 === 1 || claimedJobs.length > 0;
    if (shouldLog) {
      console.log(`[Worker] Poll #${pollCount}: claimed: ${claimedJobs.length}, active: ${activeJobs.size}/${MAX_CONCURRENT_JOBS}`);
    }

    for (const job of claimedJobs) {
      if (activeJobs.has(job.id)) continue;
      console.log(`[Worker] Claimed job ${job.id} (type: ${job.task_type})`);
      // Fire and forget — job is already marked 'processing' by the RPC
      Promise.race([
        processJob(job as Job),
        new Promise<void>((_, reject) => setTimeout(
          () => reject(new Error(`Job ${job.id} exceeded wall-clock timeout of ${JOB_TIMEOUT_MS / 60000} minutes`)),
          JOB_TIMEOUT_MS
        )),
      ]).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Worker] Job ${job.id} failed or timed out: ${errMsg}`);
        Sentry.captureException(err instanceof Error ? err : new Error(errMsg));
        // Ensure DB is updated and slot freed — processJob may still be running
        if (activeJobs.has(job.id)) {
          activeJobs.delete(job.id);
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

const POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS || "5400000", 10); // 90 min default

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

    // Find all processing jobs (orphans from previous worker instance)
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, payload, created_at, updated_at")
      .eq("status", "processing")
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

/* ---- Graceful shutdown ---- */

/**
 * Initiate graceful shutdown.
 * 1. Stop accepting new jobs (isShuttingDown = true)
 * 2. Stop the polling interval
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
  console.log(`[Worker] 🛑 Received ${signal} — initiating graceful shutdown`);
  console.log(`[Worker] Active jobs: ${activeJobs.size} — will wait up to ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s for them to finish`);

  // Stop polling for new jobs
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  await writeSystemLog({
    category: "system_info",
    eventType: "worker_shutdown_started",
    message: `Graceful shutdown initiated by ${signal} — ${activeJobs.size} active job(s)`,
    details: { signal, activeJobCount: activeJobs.size, activeJobIds: [...activeJobs] },
  });

  // Wait for active jobs to drain
  if (activeJobs.size > 0) {
    const drainStart = Date.now();
    const DRAIN_CHECK_INTERVAL = 2000;

    await new Promise<void>((resolve) => {
      const checkDrained = () => {
        const elapsed = Date.now() - drainStart;

        if (activeJobs.size === 0) {
          console.log(`[Worker] ✅ All active jobs drained in ${Math.round(elapsed / 1000)}s`);
          resolve();
          return;
        }

        if (elapsed >= SHUTDOWN_DRAIN_TIMEOUT_MS) {
          console.error(
            `[Worker] ⚠️  Shutdown drain timeout after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s — ` +
            `${activeJobs.size} job(s) still active: ${[...activeJobs].join(", ")}`
          );
          // Mark remaining active jobs as pending so they get picked up after restart
          const orphanPromises = [...activeJobs].map(async (jobId) => {
            try {
              await supabase
                .from("video_generation_jobs")
                .update({
                  status: "pending",
                  progress: 0,
                  error_message: null,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", jobId)
                .eq("status", "processing");
              console.log(`[Worker] Reset orphaned job ${jobId} to pending`);
            } catch (err) {
              console.error(`[Worker] Failed to reset job ${jobId}:`, err);
            }
          });
          Promise.allSettled(orphanPromises).then(() => resolve());
          return;
        }

        console.log(
          `[Worker] Waiting for ${activeJobs.size} active job(s) to finish... ` +
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
  // Mark any still-processing jobs as failed so they are not orphaned.
  // Fire-and-forget: do not await — we must exit promptly so the orchestrator can restart.
  supabase
    .from("video_generation_jobs")
    .update({ status: "failed", error_message: "Worker process crashed" })
    .eq("status", "processing")
    .then(() => process.exit(1), () => process.exit(1));
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[Worker] 💥 Unhandled rejection — marking jobs failed and exiting:", reason);
  const err = reason instanceof Error ? reason : new Error(String(reason));
  Sentry.captureException(err);
  // Mark any still-processing jobs as failed so they are not orphaned.
  supabase
    .from("video_generation_jobs")
    .update({ status: "failed", error_message: "Worker process crashed" })
    .eq("status", "processing")
    .then(() => process.exit(1), () => process.exit(1));
});

/** Mask an API key for safe logging: first 6 + last 4 chars visible. */
function maskKey(key: string | undefined): string {
  if (!key) return "(NOT SET)";
  const trimmed = key.trim();
  if (trimmed.length === 0) return "(EMPTY)";
  if (trimmed !== key) return `⚠️ HAS WHITESPACE — trimmed len=${trimmed.length}, raw len=${key.length}`;
  if (trimmed.length <= 12) return `${trimmed.substring(0, 3)}…${trimmed.substring(trimmed.length - 3)} (${trimmed.length} chars)`;
  return `${trimmed.substring(0, 6)}…${trimmed.substring(trimmed.length - 4)} (${trimmed.length} chars)`;
}

/* ---- Start health server ---- */
const workerStartedAt = Date.now();

startHealthServer(() => ({
  activeJobs: activeJobs.size,
  maxConcurrentJobs: MAX_CONCURRENT_JOBS,
  accepting: !isShuttingDown,
  uptimeSeconds: Math.round((Date.now() - workerStartedAt) / 1000),
  lastPollAt,
  totalJobsProcessed,
  totalJobsFailed,
}));

console.log(`[Worker] MotionMax Render Worker started. Concurrency=${MAX_CONCURRENT_JOBS}, polling every ${POLL_INTERVAL_MS}ms.`);
console.log(`[Worker] 🔑 HYPEREAL_API_KEY: ${maskKey(process.env.HYPEREAL_API_KEY)}`);
console.log(`[Worker] 🔑 REPLICATE_API_KEY: ${maskKey(process.env.REPLICATE_API_KEY)}`);
console.log(`[Worker] 🔑 OPENROUTER_API_KEY: ${maskKey(process.env.OPENROUTER_API_KEY)}`);
startupDiagnostic().then((hadOrphans) => {
  if (hadOrphans) {
    console.log(`[Worker] ⏳ Cooldown ${STARTUP_COOLDOWN_MS / 1000}s before first poll (orphans recovered)`);
    setTimeout(() => {
      pollQueue();
      pollTimer = setInterval(pollQueue, POLL_INTERVAL_MS);
    }, STARTUP_COOLDOWN_MS);
  } else {
    pollQueue();
    pollTimer = setInterval(pollQueue, POLL_INTERVAL_MS);
  }
});
