// Worker entrypoint. See worker/src/lib/* for extracted sub-systems
// (added 2026-05-10 per audit C-4-3): concurrencyBudget, masterKillSwitch,
// staleClaimReaper, startupDiagnostic, heartbeat, lifecycle,
// providerKeysBanner. Per-task-type handler dispatch and the main
// pollQueue/processJob loop remain here because they own the module-
// level pool state (activeExportJobs / activeLlmJobs / MAX_*_SLOTS).

import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from './lib/sentry-scrubber.js';
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  // billing endpoints use full trace sampling per audit C-9-2 — every failed
  // checkout MUST be reproducible. The worker runs Stripe-driven jobs
  // (subscription billing, credit top-ups, refunds) and finalize/export
  // pipelines whose failures gate user-visible billing outcomes, so we keep
  // 100 % traces here. App-wide sampling stays at 10 % via src/lib/sentry.ts.
  tracesSampleRate: 1.0,
  // PII scrubbing — strips emails, Stripe IDs, JWTs, OAuth tokens, last4 in card contexts,
  // and drops known-noise events. See worker/src/lib/sentry-scrubber.ts.
  beforeSend: scrubSentryEvent,
});

import { supabase } from "./lib/supabase.js";
import { Job } from "./types/job.js";
import { dispatchJob } from "./handlers/dispatch.js";
import {
  startAutopostDispatcher,
  startTokenRefresher,
  startAutopostDailySummary,
} from "./handlers/autopost/index.js";
import { startNewsletterSender } from "./handlers/newsletter/handleNewsletterSend.js";
import { startScheduledNotificationDispatcher } from "./handlers/notification/handleScheduledNotifications.js";
import { writeSystemLog } from "./lib/logger.js";
import { wlog } from "./lib/workerLogger.js";
import { isTransientError, retryDelayMs } from "./lib/retryClassifier.js";
import { startHealthServer } from "./healthServer.js";

import os from "os";
import { randomUUID } from "crypto";

import {
  detectOptimalConcurrency,
  isExportTask,
} from "./lib/concurrencyBudget.js";
import { isMasterKillEngaged } from "./lib/masterKillSwitch.js";
import { runStaleClaimReaper } from "./lib/staleClaimReaper.js";
import { runHyperealSlotReaper, setHyperealSlotWorkerId } from "./lib/hyperealSlots.js";
import { runStartupDiagnostic } from "./lib/startupDiagnostic.js";
import { startHeartbeatWriter } from "./lib/heartbeat.js";
import { logProviderKeysBanner } from "./lib/providerKeysBanner.js";
import { makeGracefulShutdown, registerProcessSignalHandlers } from "./lib/lifecycle.js";
import { emitQueueDepthAlert } from "./lib/queueDepthAlert.js";
import { reconcileJobMargin } from "./lib/marginReconcile.js";
// ── /api/v1 Phase 2 — sandbox short-circuit + webhook delivery ──────────────
// Sandbox detection + deterministic stub live in the worker (api/ tree is not
// importable here). Webhook delivery is owned by Builder A — we only import.
import { isSandboxPayload, buildSandboxJobResult } from "./lib/sandboxJob.js";
import { enqueueWebhook, deliverPendingWebhooks } from "./lib/webhookDelivery.js";
// Webhook `data`/`error` MUST mirror the api/v1 GET handler's contract mapping
// (the worker can't import api/) so a customer's webhook == their GET /videos/{id}.
import { normalizeSuccessResult, normalizeFailureError } from "./lib/apiResultNormalize.js";

/* ---- Per-task-type worker pools ----
 * FFmpeg exports (export_video) are CPU+memory-bound and compete with AI API calls
 * if they share the same slot pool. Separate pools let each type scale independently.
 */
const activeExportJobs = new Set<string>(); // export_video — FFmpeg, CPU/memory-heavy
const activeLlmJobs    = new Set<string>(); // all other task types — AI APIs, network-bound

function getActivePool(taskType: string): Set<string> {
  return isExportTask(taskType) ? activeExportJobs : activeLlmJobs;
}

function allActiveJobIds(): string[] {
  return [...activeExportJobs, ...activeLlmJobs];
}

function totalActiveJobs(): number {
  return activeExportJobs.size + activeLlmJobs.size;
}

const _baselineBudget = detectOptimalConcurrency();

// Auto-tune is now pool-aware: detectOptimalConcurrency returns sizes
// for each pool separately rather than a single total to be split.
// Per-pool env overrides (WORKER_EXPORT_CONCURRENCY / WORKER_LLM_CONCURRENCY)
// still take precedence over the auto-tune values for fine-tuning. The
// runtime override from app_settings.worker_concurrency_override
// (poll loop further down) can replace `MAX_CONCURRENT_JOBS` at runtime —
// when set, we re-derive MAX_EXPORT_SLOTS and MAX_LLM_SLOTS proportionally
// so the same export/LLM ratio holds at any total. Vars are `let` so the
// poll can mutate them.
let MAX_EXPORT_SLOTS = process.env.WORKER_EXPORT_CONCURRENCY
  ? parseInt(process.env.WORKER_EXPORT_CONCURRENCY, 10)
  : _baselineBudget.exportSlots;
let MAX_LLM_SLOTS = process.env.WORKER_LLM_CONCURRENCY
  ? parseInt(process.env.WORKER_LLM_CONCURRENCY, 10)
  : _baselineBudget.llmSlots;
let MAX_CONCURRENT_JOBS = MAX_EXPORT_SLOTS + MAX_LLM_SLOTS;
// The override currently in effect (null = no override; using env/auto-tune).
let currentConcurrencyOverride: number | null = null;

/**
 * Apply a new total-slot count (or null to revert to env/auto-tune baseline).
 * In-flight jobs are NEVER killed — we only gate new claims at the new value,
 * so an admin lowering the cap below current active count just means natural
 * drain. Raising the cap is immediate.
 */
function applyConcurrencyOverride(override: number | null) {
  if (override === currentConcurrencyOverride) return; // no-op

  const previous = MAX_CONCURRENT_JOBS;
  if (override !== null && Number.isFinite(override) && override > 0) {
    // Admin override path. The override value is a TOTAL slot budget;
    // we re-derive per-pool sizes by holding the export/LLM ratio used
    // by the auto-tune baseline (typically ~10–15% export / ~85–90% LLM
    // on Render Pro now that LLM is memory-bound). Floors: 1 export,
    // 2 LLM — never starve a pool entirely.
    const baselineRatio = _baselineBudget.exportSlots / Math.max(1, _baselineBudget.total);
    const exportSlots = Math.max(1, Math.floor(override * baselineRatio));
    const llmSlots    = Math.max(2, override - exportSlots);
    MAX_EXPORT_SLOTS = exportSlots;
    MAX_LLM_SLOTS    = llmSlots;
    MAX_CONCURRENT_JOBS = exportSlots + llmSlots;
  } else {
    // Revert to baseline (pool-aware: per-pool env overrides still win).
    const exportSlots = process.env.WORKER_EXPORT_CONCURRENCY
      ? parseInt(process.env.WORKER_EXPORT_CONCURRENCY, 10)
      : _baselineBudget.exportSlots;
    const llmSlots = process.env.WORKER_LLM_CONCURRENCY
      ? parseInt(process.env.WORKER_LLM_CONCURRENCY, 10)
      : _baselineBudget.llmSlots;
    MAX_EXPORT_SLOTS = exportSlots;
    MAX_LLM_SLOTS = llmSlots;
    MAX_CONCURRENT_JOBS = exportSlots + llmSlots;
  }
  currentConcurrencyOverride = override;
  queueDepthAlertThreshold = MAX_CONCURRENT_JOBS * 2;

  wlog.info("Concurrency override applied", {
    previous,
    new_total: MAX_CONCURRENT_JOBS,
    export: MAX_EXPORT_SLOTS,
    llm: MAX_LLM_SLOTS,
    override_value: override,
  });
}

/**
 * Poll the app_settings.worker_concurrency_override jsonb value and apply
 * any change. Runs every 60s. Errors are logged but never throw — concurrency
 * stays at whatever it was last set to.
 */
async function pollConcurrencyOverride(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "worker_concurrency_override")
      .maybeSingle();
    if (error) {
      wlog.warn("Concurrency override poll failed", { error: error.message });
      return;
    }
    // value is jsonb — null OR an int. Coerce safely.
    const raw = (data as { value?: unknown } | null)?.value ?? null;
    let override: number | null = null;
    if (raw !== null && typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      override = Math.max(1, Math.min(64, Math.floor(raw)));
    }
    applyConcurrencyOverride(override);
  } catch (err) {
    wlog.warn("Concurrency override poll exception", { err: String(err) });
  }
}

/* ---- Worker identity ---- */
// Unique per-process ID stamped onto every claimed job.
// Allows the startup diagnostic to scope resets to THIS worker's own rows
// rather than blindly touching rows owned by sibling replicas.
const WORKER_ID: string = `${os.hostname()}-${process.pid}-${randomUUID()}`;

// Propagate to the fleet-wide Hypereal slot limiter (C-8-1). Doing this at
// module load (rather than in main()) ensures any handler firing on the
// first claim cycle already has a worker_id to stamp on its slot row.
setHyperealSlotWorkerId(WORKER_ID);

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

/* ---- /api/v1 webhook delivery sweep state (roadmap §Phase 2) ---- */
// deliverPendingWebhooks (Builder A) drains the webhook outbox: signs +
// POSTs pending deliveries, applies exponential backoff on failure. We run
// it on a ~15s interval alongside the other worker loops, guarded against
// overlap so a slow sweep (many retries) never stacks concurrent runs.
const WEBHOOK_SWEEP_INTERVAL_MS = 15_000;
let webhookSweepInFlight = false;
let webhookSweepTimer: ReturnType<typeof setInterval> | null = null;
let webhookSweepRuns = 0; // process-lifetime count of sweep invocations (metrics)

/* ---- Transient-error retry helpers ---- */
// isTransientError and retryDelayMs imported from ./lib/retryClassifier.js

const MAX_JOB_RETRIES = 3;

// TODO(worker-hardening-wave) G-M11 (duplicate of F-CH-10):
//   `withTransientRetry` retries any classified-transient error, but
//   it has no idempotency guard on duplicate-row INSERTs. Specifically:
//     • If a handler's first attempt INSERTs a child job row, then
//       errors on a downstream call (e.g. master_audio insert OK,
//       cinematic_image insert classified as transient via 429),
//       attempt 2 re-runs the entire handler — including the
//       already-successful master_audio INSERT. The DB unique-index
//       on (project_id, task_type, depends_on_hash) catches some of
//       these (added in migration 20260510). But handlers that
//       INSERT without depends_on (master_audio, plain image regen
//       in some paths) can still produce duplicate child rows.
//     • Symptom: 2× Gemini TTS calls billed for one user click.
//   Proposed fix (deferred — needs test scaffolding around the
//   handler chain to verify):
//     1. Pass `attempt` into the handler (already done via `fn(attempt)`).
//     2. Handlers that INSERT child rows should use an idempotency
//        key derived from (parent jobId, child task_type, attempt-0
//        signature) so attempt > 0 re-INSERTs are no-ops.
//     3. Alternative: wrap the INSERT in a "find-or-create" RPC that
//        returns the existing row on conflict.
//   The existing tests in worker/src/handlers/*.test.ts don't cover
//   the cross-attempt persistence path — they isolate the handler
//   from the retry wrapper. Worker-hardening wave needs a new test
//   harness that exercises (attempt=0 partial-fail, attempt=1 retry)
//   end-to-end before this can ship safely.
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
// Extracted to ./refundCreditsOnFailure.ts so unit tests can import the
// REAL implementation without booting all of index.ts (which starts the
// health server, autopost dispatcher, etc.). See worker/src/refundCreditsOnFailure.test.ts.
import { refundCreditsOnFailure } from "./refundCreditsOnFailure.js";
// /api/v1 gateway jobs refund cost-aware (charged − provider spend), NOT the
// full refund refundCreditsOnFailure issues (which also skips API task_types).
import { isApiJob, costAwareRefundApiJob } from "./lib/apiJobRefund.js";
// Re-export so any other module importing these from "./index.js" keeps working.
export {
  refundCreditsOnFailure,
  REFUNDABLE_TASK_TYPES,
  getCreditCost,
  LENGTH_SECONDS,
  PRODUCT_MULT,
} from "./refundCreditsOnFailure.js";

/**
 * C-7-7: timeoutAborted is set when the per-job hard-timeout
 * AbortController fired before processJob finished. We use this to
 * make the failed-write path atomic with the timeout decision: if
 * timeoutAborted is true at the point we'd normally mark 'completed',
 * we instead route through the catch path that marks 'failed' — so a
 * still-running handler that resolves AFTER the timeout fired can
 * never clobber the timeout's terminal 'failed' state.
 */
async function processJob(job: Job, signal?: AbortSignal) {
  const pool = getActivePool(job.task_type);
  pool.add(job.id);

  // Helper: throws a recognizable AbortError if the hard-timeout fired
  // mid-handler. Used at the boundaries between the handler returning
  // and us writing the terminal status, so a late-arriving handler
  // resolution can't race against a timeout-induced 'failed' mark.
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error(`Job ${job.id} (${job.task_type}) hard-timeout aborted`);
      err.name = "AbortError";
      throw err;
    }
  };

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

    // ── /api/v1 SANDBOX SHORT-CIRCUIT (roadmap §Phase 2 — Sandbox) ──────────
    // mm_test_ keys exercise the full request path (auth/validate/moderate) but
    // MUST NOT spend on real providers. The gateway tags such jobs with
    // payload.sandbox === true and inserts them pending; we detect that here —
    // as early as possible after the claim, BEFORE any handler dispatch — and
    // write a deterministic terminal-success WITHOUT calling any provider.
    // We still go through the outbox + (id, worker_id, status='processing')
    // terminal UPDATE so job_results is marked applied exactly like the happy
    // path, and fire the success webhook. Then return.
    if (isSandboxPayload(job.payload)) {
      throwIfAborted();
      const sandboxResult = buildSandboxJobResult(job.payload);
      const sandboxPayload = {
        ...finalPayload,
        ...sandboxResult,
        sandbox: true,
      };
      const { _restartCount: _rcSb, ...cleanSandboxPayload } = sandboxPayload as Record<string, unknown>;

      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: "system_info",
        eventType: "job_completed",
        message: `Worker short-circuited sandbox job ${job.id} (no provider spend)`,
      });

      // Outbox first (safety net), then terminal UPDATE — same ordering and
      // (id, worker_id, status='processing') guards as the real success path.
      try {
        const { error: sbOutboxErr } = await (supabase as any)
          .from('job_results')
          .upsert({
            job_id: job.id,
            result: cleanSandboxPayload,
            worker_id: WORKER_ID,
            applied_at: null,
          }, { onConflict: 'job_id' });
        if (sbOutboxErr) {
          wlog.warn("Sandbox outbox write failed — relying on UPDATE path only", {
            jobId: job.id, workerId: WORKER_ID, error: sbOutboxErr.message,
          });
        }
      } catch (sbOutboxThrow) {
        wlog.warn("Sandbox outbox write threw — relying on UPDATE path only", {
          jobId: job.id, workerId: WORKER_ID,
          error: sbOutboxThrow instanceof Error ? sbOutboxThrow.message : String(sbOutboxThrow),
        });
      }

      const { error: sbCompleteError, count: sbCompleteCount } = await (supabase as any)
        .from('video_generation_jobs')
        .update({
          status: 'completed',
          progress: 100,
          payload: cleanSandboxPayload,
          result: cleanSandboxPayload,
          updated_at: new Date().toISOString(),
        }, { count: 'exact' })
        .eq('id', job.id)
        .eq('worker_id', WORKER_ID)
        .eq('status', 'processing');

      if (sbCompleteError) {
        console.error(`[Worker] Failed to mark sandbox job ${job.id} as completed:`, sbCompleteError.message);
        Sentry.captureException(sbCompleteError, { tags: { jobId: job.id, phase: "mark-completed-sandbox" } });
      } else if (sbCompleteCount === 0) {
        wlog.warn("Sandbox terminal 'completed' UPDATE matched 0 rows — claim handed off OR cancelled", {
          jobId: job.id, workerId: WORKER_ID, taskType: job.task_type,
        });
      } else {
        void (supabase as any)
          .from('job_results')
          .update({ applied_at: new Date().toISOString() })
          .eq('job_id', job.id)
          .then(() => {}, () => {});
      }

      // Best-effort success webhook for the sandbox job. Never affects status.
      const sbCallbackUrl = (job as { callback_url?: string | null }).callback_url ?? null;
      const sbAccountId = (job as { account_id?: string | null }).account_id ?? null;
      if (sbCallbackUrl && sbAccountId) {
        try {
          await enqueueWebhook(supabase, {
            accountId: sbAccountId,
            jobId: job.id,
            callbackUrl: sbCallbackUrl,
            event: 'video.succeeded',
            result: cleanSandboxPayload,
          });
        } catch (whErr) {
          wlog.warn("Sandbox success webhook enqueue failed (ignored)", {
            jobId: job.id,
            error: whErr instanceof Error ? whErr.message : String(whErr),
          });
        }
      }

      totalJobsProcessed++;
      return;
    }

    await withTransientRetry(async (attempt) => {
      throwIfAborted(); // C-7-7: stop retrying once the hard-timeout fired
      if (attempt > 0) {
        await writeSystemLog({
          jobId: job.id,
          projectId: job.project_id ?? undefined,
          userId: job.user_id,
          category: "system_info",
          eventType: "job_retry",
          message: `Retrying job ${job.id} (attempt ${attempt + 1}/${MAX_JOB_RETRIES}) after transient error`,
        });
        // C-7-9: tell idempotent orchestrators (e.g. handleAutopostRun)
        // that this is an in-process transient retry, not a fresh claim.
        // Without this, the autopost run's `progress_pct > 0` idempotence
        // gate trips on the second attempt and terminal-fails the run,
        // turning the retry into a single-shot no-op.
        (job.payload as Record<string, unknown>)._transientRetryAttempt = attempt;
      }

      // Per-task-type dispatch lives in worker/src/handlers/dispatch.ts.
      // Each handler returns a partial result object; we merge into
      // finalPayload so both the legacy `payload` column and the new
      // `result` column carry the same data. signal is threaded so
      // hard-timeout-aware handlers (currently master_audio → Gemini
      // TTS fetch) can cancel in-flight network calls cleanly instead
      // of running to completion past the abort.
      const patch = await dispatchJob(job, signal);
      finalPayload = { ...finalPayload, ...patch };
    }, {
      jobId: job.id,
      // Autopost orchestrators (autopost_render / autopost_rerender)
      // re-submit the script-gen LLM call + downstream child jobs on
      // every pipeline attempt — three transient retries can quietly
      // 2-3× the Hypereal/OpenRouter spend on a single user-facing run.
      // Now that failed runs surface a manual Regen button in the UI
      // (RunHistory.tsx performRegenerate), silent in-process retries
      // are net-negative: more risk than recovery. Cap autopost paths
      // at 1 attempt (no auto-retry); idempotent jobs keep the default
      // MAX_JOB_RETRIES so genuinely-transient blips on cheap work
      // still self-heal.
      maxAttempts:
        job.task_type === 'autopost_render' || job.task_type === 'autopost_rerender'
          ? 1
          : MAX_JOB_RETRIES,
    });

    // C-7-7: if the hard-timeout fired while the handler was still
    // running (i.e. the handler resolved AFTER the abort), route to
    // the catch path instead of writing 'completed'. The timeout's
    // .catch in pollQueue already wrote 'failed'; we must NOT clobber
    // it with 'completed'.
    throwIfAborted();

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

    // C-7-11: scope the terminal UPDATE to (id, worker_id) so a stale
    // reaper reset + re-claim by another worker is NOT clobbered by
    // this worker's late completion. If 0 rows are affected, log it.
    //
    // Also scope to status='processing': the cancel feature flips
    // user-cancelled rows to status='failed' + error_message=
    // 'Cancelled by user' while the worker is still mid-execution.
    // Without this filter the worker's terminal UPDATE would clobber
    // the cancellation back to 'completed' as if nothing happened. By
    // only matching rows still in 'processing' we let the user's
    // cancellation be sticky — the 0-rows-affected case below is the
    // healthy outcome on a successful cancel.
    // Outbox: durably stash the result BEFORE the terminal UPDATE,
    // so a DB-pressure timeout on the UPDATE doesn't lose the
    // in-memory video URL. apply_outbox_results() (pg_cron, every
    // minute) sweeps any unapplied row >30s old using the same
    // (id, worker_id, status='processing') filter we use below —
    // so cancellations / reaper handoffs are never clobbered.
    // UPSERT on job_id so a reaper-revived re-run replaces any
    // stale prior attempt instead of failing on the PK constraint.
    // Wrapped in try/catch because an outbox failure must NOT
    // abort the regular UPDATE path — outbox is the SAFETY NET,
    // not the primary write. If both fail, the stale-claim reaper
    // is still the ultimate backstop.
    try {
      const { error: outboxErr } = await (supabase as any)
        .from('job_results')
        .upsert({
          job_id: job.id,
          result: cleanPayload,
          worker_id: WORKER_ID,
          applied_at: null,
        }, { onConflict: 'job_id' });
      if (outboxErr) {
        wlog.warn("Outbox write failed — relying on UPDATE path only", {
          jobId: job.id, workerId: WORKER_ID, error: outboxErr.message,
        });
      }
    } catch (outboxThrow) {
      wlog.warn("Outbox write threw — relying on UPDATE path only", {
        jobId: job.id, workerId: WORKER_ID,
        error: outboxThrow instanceof Error ? outboxThrow.message : String(outboxThrow),
      });
    }

    const { error: completeError, count: completeCount } = await (supabase as any)
      .from('video_generation_jobs')
      .update({
        status: 'completed',
        progress: 100,
        payload: cleanPayload,
        result: cleanPayload,       // also write result so pollWorkerJob always finds it
        updated_at: new Date().toISOString()
      }, { count: 'exact' })
      .eq('id', job.id)
      .eq('worker_id', WORKER_ID)
      .eq('status', 'processing');

    if (completeError) {
      console.error(`[Worker] Failed to mark job ${job.id} as completed:`, completeError.message);
      Sentry.captureException(completeError, { tags: { jobId: job.id, phase: "mark-completed" } });
      // Retry once — this is critical, otherwise the frontend polls forever.
      // Keep the worker_id + status filters on the retry; if the reaper
      // handed off this row OR the user cancelled, refusing to clobber
      // is correct. Mirrors the mark-failed last-resort pattern below:
      // both the result.error path (e.g. statement_timeout) and the
      // promise-rejection path (transport failure) must be observed,
      // otherwise the job is stranded silently and the frontend polls
      // forever.
      const retryRes = await (supabase as any)
        .from('video_generation_jobs')
        .update({ status: 'completed', progress: 100, result: cleanPayload, updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('worker_id', WORKER_ID)
        .eq('status', 'processing')
        .then(
          (r: { error: unknown }) => r,
          (rejectErr: unknown) => ({ error: rejectErr }),
        );
      if (retryRes?.error) {
        const retryErr = retryRes.error;
        // Supabase REST errors are plain {message,code,details,hint}
        // objects, not Error instances — String(obj) on them yields
        // "[object Object]". Pluck the useful fields explicitly so the
        // log line tells us what actually went wrong (statement_timeout,
        // RLS, etc.) instead of a useless toString.
        const e = retryErr as { message?: string; code?: string; details?: string; hint?: string } | null;
        const retryMsg =
          retryErr instanceof Error
            ? retryErr.message
            : e && typeof e === "object"
            ? `${e.code ?? "?"}: ${e.message ?? "(no message)"}${e.details ? ` — ${e.details}` : ""}`
            : String(retryErr);
        wlog.error("CRITICAL: Mark-completed retry ALSO failed — job stranded until stale-claim reaper resets it", {
          jobId: job.id,
          workerId: WORKER_ID,
          taskType: job.task_type,
          firstError: completeError.message,
          retryError: retryMsg,
        });
        Sentry.captureException(retryErr, { tags: { jobId: job.id, phase: "mark-completed-retry" } });
      } else {
        // Retry succeeded — mark the outbox row applied so the
        // sweeper doesn't redundantly re-apply it.
        void (supabase as any)
          .from('job_results')
          .update({ applied_at: new Date().toISOString() })
          .eq('job_id', job.id)
          .then(() => {}, () => {}); // best-effort, sweeper will catch any miss
      }
    } else if (completeCount === 0) {
      wlog.warn("Terminal 'completed' UPDATE matched 0 rows — claim handed off mid-run OR user cancelled", {
        jobId: job.id, workerId: WORKER_ID, taskType: job.task_type,
      });
    } else {
      // Happy path: primary UPDATE succeeded. Mark the outbox row
      // applied so the every-minute sweeper doesn't re-scan it.
      // The sweeper would otherwise see this row as 'unapplied'
      // for 30s and burn one idempotent UPDATE per job. Best-effort
      // — if this fails, the sweeper still does the right thing
      // (finds the job already 'completed' and marks the outbox).
      void (supabase as any)
        .from('job_results')
        .update({ applied_at: new Date().toISOString() })
        .eq('job_id', job.id)
        .then(() => {}, () => {});
    }

    totalJobsProcessed++;

    // ── Margin reconciliation (Builder H, roadmap §1.3 G-M) ──────────
    // Best-effort, non-throwing. Only billed root jobs carry a positive
    // creditsDeducted in payload (gateway worst-rung quote or the browser
    // path's getCreditCost); downstream child jobs (finalize/export/etc.)
    // have no charge of their own, so reconcileJobMargin no-ops on them
    // (creditsCharged <= 0 → null). Sums api_call_logs.cost for this job,
    // values the charged credits at CREDIT_USD_RATE, emits the
    // api_job_margin_usd gauge and warns when the job lost money. Fired
    // after the terminal write so a reconciliation hiccup can never
    // affect the job's completed status.
    const creditsCharged =
      typeof (cleanPayload as { creditsDeducted?: unknown }).creditsDeducted === "number"
        ? (cleanPayload as { creditsDeducted: number }).creditsDeducted
        : 0;
    if (creditsCharged > 0) {
      await reconcileJobMargin(job.id, creditsCharged).catch((reconErr) => {
        wlog.warn("Margin reconciliation call failed (ignored)", {
          jobId: job.id,
          error: reconErr instanceof Error ? reconErr.message : String(reconErr),
        });
      });
    }

    // ── /api/v1 WEBHOOK on terminal SUCCESS (roadmap §Phase 2 — Webhooks) ───
    // API jobs carry a callback_url + account_id (gateway-stamped). On a
    // terminal success we enqueue a 'video.succeeded' delivery (Builder A's
    // webhookDelivery owns signing/retry/backoff). Best-effort: a webhook
    // enqueue failure must NEVER affect the job's completed status — fired
    // after the terminal write, wrapped in try/catch.
    const successCallbackUrl = (job as { callback_url?: string | null }).callback_url ?? null;
    const successAccountId = (job as { account_id?: string | null }).account_id ?? null;
    if (successCallbackUrl && successAccountId) {
      try {
        await enqueueWebhook(supabase, {
          accountId: successAccountId,
          jobId: job.id,
          callbackUrl: successCallbackUrl,
          event: 'video.succeeded',
          // Normalize cleanPayload → VideoResult-shaped fields (same fallbacks
          // the GET handler uses) so the webhook isn't all-null on real success.
          result: normalizeSuccessResult(cleanPayload as Record<string, unknown>),
        });
      } catch (whErr) {
        wlog.warn("Success webhook enqueue failed (ignored)", {
          jobId: job.id,
          error: whErr instanceof Error ? whErr.message : String(whErr),
        });
      }
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    // Idempotence-skip detection — handleAutopostRun and similar
    // defensive handlers throw with a recognizable prefix when they
    // refuse to re-run a terminal pipeline (e.g. autopost_run already
    // failed/cancelled/completed). That's the designed behavior, NOT
    // an error worth a `system_error` row + Sentry-grade attention.
    // Demote the log severity so the dashboard isn't full of
    // "every fucking time" noise on duplicate orchestrator claims.
    const isIdempotenceSkip =
      errorMsg.includes("already in terminal status=") ||
      errorMsg.includes("already finished (status=") ||
      errorMsg.includes("refusing to re-run") ||
      errorMsg.includes("refusing duplicate run");

    // Log the failure — wrapped in try/catch to guarantee we reach the status update
    try {
      await writeSystemLog({
        jobId: job.id,
        projectId: job.project_id ?? undefined,
        userId: job.user_id,
        category: isIdempotenceSkip ? "system_info" : "system_error",
        eventType: isIdempotenceSkip ? "job_skipped_duplicate" : "job_failed",
        message: isIdempotenceSkip
          ? `Worker skipped duplicate job ${job.id}: ${errorMsg}`
          : `Worker failed processing job ${job.id}: ${errorMsg}`,
        details: { stack: error instanceof Error ? error.stack : null }
      });
    } catch (logErr) {
      console.error(`[Worker] Failed to write log for ${job.id}:`, logErr);
    }

    // Refund credits for failed generation. API jobs use the cost-aware path
    // (refund only the unspent portion); the browser path keeps its full refund.
    try {
      if (isApiJob(job)) {
        await costAwareRefundApiJob(job);
      } else {
        await refundCreditsOnFailure(job);
      }
    } catch (refundErr) {
      console.error(`[Worker] Refund failed for ${job.id}:`, refundErr);
    }

    // CRITICAL: Mark the job as failed — if this doesn't happen, the frontend polls forever.
    // C-7-11: scope to (id, worker_id) so a stale-claim reaper reset + re-claim by another
    // worker is NOT clobbered by this worker's late failure. 0 rows-affected = log a warning.
    // Also scope to status='processing' so we don't overwrite a
    // user cancellation's "Cancelled by user" error_message with the
    // worker's own error text — same reasoning as the success path.
    const { error: failError, count: failCount } = await (supabase as any)
      .from('video_generation_jobs')
      .update({
        status: 'failed',
        error_message: errorMsg,
        updated_at: new Date().toISOString()
      }, { count: 'exact' })
      .eq('id', job.id)
      .eq('worker_id', WORKER_ID)
      .eq('status', 'processing');

    if (failError) {
      console.error(`[Worker] CRITICAL: Failed to mark job ${job.id} as failed:`, failError.message);
      // Last resort retry — still scoped to worker_id + status='processing';
      // if the reaper reassigned the row OR the user cancelled, we must
      // NOT clobber the new state.
      await supabase
        .from('video_generation_jobs')
        .update({ status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('worker_id', WORKER_ID)
        .eq('status', 'processing')
        .then(
          () => {},
          (retryErr: unknown) => {
            wlog.error("CRITICAL: Last-resort mark-failed also failed", { jobId: job.id, error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
            Sentry.captureException(retryErr, { tags: { jobId: job.id, phase: "mark-failed-retry" } });
          },
        );
    } else if (failCount === 0) {
      wlog.warn("Terminal 'failed' UPDATE matched 0 rows — claim handed off mid-run", {
        jobId: job.id, workerId: WORKER_ID, taskType: job.task_type,
      });
    }

    // Move to dead-letter queue so permanently-failed jobs can be triaged
    // separately without clogging the active job table.
    // AWAITED (no longer fire-and-forget): if the worker process exits right
    // after marking the job failed, an un-awaited insert could be dropped and
    // the failure would never reach the DLQ for triage/requeue. We await it,
    // and on error log a warning + continue (the job is already marked failed,
    // so a DLQ miss must not block the rest of the failure path).
    // account_id is carried through (nullable) so API-originated failures are
    // attributable to a tenant account and can be requeued via
    // api_requeue_dead_letter().
    try {
      const { error: dlqInsertErr } = await supabase
        .from("dead_letter_jobs")
        .insert({
          source_job_id: job.id,
          task_type: job.task_type,
          payload: job.payload,
          error_message: errorMsg,
          attempts: (job.payload?._restartCount ?? 0) + 1,
          user_id: job.user_id ?? null,
          account_id: (job as any).account_id ?? null,
          project_id: job.project_id ?? null,
          worker_id: WORKER_ID,
        });
      if (dlqInsertErr) {
        wlog.warn("Dead-letter insert failed", { jobId: job.id, error: dlqInsertErr.message });
      }
    } catch (dlqErr: unknown) {
      wlog.warn("Dead-letter insert failed", { jobId: job.id, error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr) });
    }

    totalJobsFailed++;

    // ── /api/v1 WEBHOOK on terminal FAILURE (roadmap §Phase 2 — Webhooks) ───
    // Mirror of the success path: enqueue a 'video.failed' delivery for API
    // jobs (callback_url + account_id present). Best-effort — must never
    // re-throw out of the catch block and mask the original error.
    try {
      const failCallbackUrl = (job as { callback_url?: string | null }).callback_url ?? null;
      const failAccountId = (job as { account_id?: string | null }).account_id ?? null;
      if (failCallbackUrl && failAccountId) {
        await enqueueWebhook(supabase, {
          accountId: failAccountId,
          jobId: job.id,
          callbackUrl: failCallbackUrl,
          event: 'video.failed',
          // Normalize the error the SAME way GET does: content-policy rejections
          // (E005 etc.) collapse to a stable code + generic message — never leak
          // the raw provider token via the webhook channel.
          result: {
            error: normalizeFailureError(errorMsg),
          },
        });
      }
    } catch (whErr) {
      wlog.warn("Failure webhook enqueue failed (ignored)", {
        jobId: job.id,
        error: whErr instanceof Error ? whErr.message : String(whErr),
      });
    }
  } finally {
    pool.delete(job.id);
  }
}

let pollCount = 0;
let lastMasterKillLogAt = 0;

async function pollQueue() {
  // Do not pick up new jobs if shutting down
  if (isShuttingDown) return;

  // Master kill switch — flipping this in the admin tab should quiesce
  // the worker within ~10s (cache TTL). Active jobs continue to drain
  // naturally since we only gate new claims, never kill in-flight work.
  if (await isMasterKillEngaged()) {
    const now = Date.now();
    if (now - lastMasterKillLogAt > 60_000) {
      lastMasterKillLogAt = now;
      wlog.warn("Master kill switch engaged — skipping job claim", {
        activeExportJobs: activeExportJobs.size,
        activeLlmJobs: activeLlmJobs.size,
      });
      // Mirror to system_logs so the admin tab's activity feed surfaces
      // the worker's response. Fire-and-forget; never block the tick.
      writeSystemLog({
        category: "system_warning",
        eventType: "kill_switch.master.observed",
        message: "Worker observed master kill switch engaged — claim loop paused",
        details: { workerId: WORKER_ID },
      }).catch(() => { /* non-fatal */ });
    }
    return;
  }

  pollCount++;
  try {
    const exportAvailable = MAX_EXPORT_SLOTS - activeExportJobs.size;
    const llmAvailable    = MAX_LLM_SLOTS    - activeLlmJobs.size;

    if (exportAvailable <= 0 && llmAvailable <= 0) return;

    // Stale-claim reaper — runs every 12 polls (~1 min @ 5s polling).
    // See worker/src/lib/staleClaimReaper.ts for per-task-type windows
    // and fail-closed behavior for autopost orchestrators.
    if (pollCount % 12 === 0) {
      await runStaleClaimReaper();
      // Hypereal fleet-wide slot reaper (C-8-1). Releases any slot
      // held >5 min — the holder is presumed dead. Cheap UPDATE on a
      // 12-row table, fine to ride the same cadence as the stale-claim
      // reaper.
      await runHyperealSlotReaper();
    }

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
        emitQueueDepthAlert({
          totalPending: totalPending ?? 0,
          threshold: queueDepthAlertThreshold,
          activeExportJobs: activeExportJobs.size,
          activeLlmJobs: activeLlmJobs.size,
          maxExportSlots: MAX_EXPORT_SLOTS,
          maxLlmSlots: MAX_LLM_SLOTS,
          workerId: WORKER_ID,
        });
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

      // C-7-7: AbortController-driven hard timeout. The previous
      // Promise.race pattern let the handler keep running after the
      // timeout fired, racing the final 'completed' write against the
      // timeout's 'failed' write. With AbortController:
      //   1. setTimeout fires ctrl.abort() at the hard-timeout boundary.
      //   2. processJob checks signal.aborted at every safe point
      //      (between retries + before the terminal-write). When set,
      //      processJob's own catch block writes 'failed' atomically.
      //   3. The outer .catch only needs to free the slot + log; it no
      //      longer writes a duplicate 'failed' row that could race
      //      with the inner success-write.
      // Handlers don't yet thread `signal` down into Hypereal/Replicate
      // fetches — that requires wider service surgery. The throwIfAborted
      // guards inside processJob cover the worst case (handler runs to
      // completion past the timeout): the success path is bypassed and
      // we route to the failed-write path.
      const ctrl = new AbortController();
      const timeoutMs = getJobTimeoutMs(job.task_type);
      const timeoutId = setTimeout(() => {
        ctrl.abort();
        wlog.warn("Hard timeout fired — aborting handler", {
          jobId: job.id, taskType: job.task_type, timeoutMs,
        });
      }, timeoutMs);

      // Fire and forget — job is already marked 'processing' by the RPC.
      processJob(job as Job, ctrl.signal)
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          // processJob's own catch handler already wrote 'failed' and
          // moved the row to dead_letter_jobs. This outer .catch only
          // triggers when processJob itself throws (e.g. one of its
          // wlog/Sentry writes blew up). Log + free the slot defensively.
          console.error(`[Worker] processJob unexpected throw for ${job.id}: ${errMsg}`);
          Sentry.captureException(err instanceof Error ? err : new Error(errMsg));
          const pool = getActivePool(job.task_type);
          if (pool.has(job.id)) pool.delete(job.id);
        })
        .finally(() => {
          clearTimeout(timeoutId);
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
// cinematic video polling can run very long under Hypereal queue pressure
// (Seedance/Kling jobs occasionally sit in 'processing' for 20–30 min);
// pure-LLM jobs should fail fast if a provider hangs.
const EXPORT_JOB_TIMEOUT_MS  = parseInt(process.env.EXPORT_JOB_TIMEOUT_MS  || "5400000",  10); // 90 min
// Cinematic video polling: Hypereal-side queue + actual rendering can
// legitimately need 30+ min on a single 10s scene (provider-side queue
// depth varies). Bumped 15 → 45 min after launch-readiness check.
const CINEMATIC_VIDEO_TIMEOUT_MS = parseInt(process.env.CINEMATIC_VIDEO_TIMEOUT_MS || "2700000", 10); // 45 min
const LLM_JOB_TIMEOUT_MS     = parseInt(process.env.LLM_JOB_TIMEOUT_MS     || "900000",   10); // 15 min
// Lipsync_finalize submits to sync.so direct (https://api.sync.so/v2) and
// polls up to 20 min for completion. sync.so direct is 3-5× faster than
// Replicate-hosted (no queue middleman). Handler hard wrap = poll cap +
// 5 min for the post-completion rehost step (download from sync.so +
// upload to Supabase video bucket). 25 min total.
const LIPSYNC_JOB_TIMEOUT_MS = parseInt(process.env.LIPSYNC_JOB_TIMEOUT_MS || "1500000",  10); // 25 min
// Autopost orchestrator runs the FULL pipeline (script → audio → images →
// [video] → finalize → export) inline by polling each child job. The
// orchestrator already has a 3 h watchdog on its child jobs, but if the
// dispatcher itself wedges (waitForJob in a polling loop where the row
// row never transitions), no inner timeout will fire. 3.5 h is the
// outer safety net — past every per-phase budget combined.
const AUTOPOST_JOB_TIMEOUT_MS = parseInt(process.env.AUTOPOST_JOB_TIMEOUT_MS || "12600000", 10); // 3.5 h
const JOB_TIMEOUT_MS         = parseInt(process.env.JOB_TIMEOUT_MS          || "5400000",  10); // legacy override

function getJobTimeoutMs(taskType: string): number {
  if (process.env.JOB_TIMEOUT_MS) return JOB_TIMEOUT_MS; // honour explicit override
  if (taskType === "autopost_render" || taskType === "autopost_rerender") return AUTOPOST_JOB_TIMEOUT_MS;
  if (taskType === "cinematic_video") return CINEMATIC_VIDEO_TIMEOUT_MS;
  if (taskType === "lipsync_finalize") return LIPSYNC_JOB_TIMEOUT_MS;
  return isExportTask(taskType) ? EXPORT_JOB_TIMEOUT_MS : LLM_JOB_TIMEOUT_MS;
}

/** Cooldown (ms) before first poll after recovering orphaned jobs.
 *  Prevents the crash-restart-pick-up-crash loop. */
const STARTUP_COOLDOWN_MS = 10_000;

/** Subscribe to Supabase Realtime so new pending jobs trigger an immediate poll
 *  rather than waiting for the 30s fallback interval. */
function subscribeToQueue() {
  // Per-instance channel name (was 'worker-job-queue' shared across all
  // replicas, which caused CHANNEL_ERROR oscillation under horizontal scale —
  // each replica subscribing the same name triggers Supabase Realtime
  // contention. Unique-per-replica name eliminates the noise. Fallback poll
  // covers any individual subscribe failure.
  realtimeChannel = supabase
    .channel(`worker-job-queue-${WORKER_ID}`)
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

/**
 * /api/v1 webhook delivery sweep. Drains pending webhook deliveries via
 * Builder A's deliverPendingWebhooks. Overlap-guarded (webhookSweepInFlight)
 * so a long-running sweep never stacks; skips while shutting down. Always
 * best-effort — never throws into the interval.
 */
async function runWebhookSweep(): Promise<void> {
  if (isShuttingDown) return;
  if (webhookSweepInFlight) return; // previous sweep still running — skip
  webhookSweepInFlight = true;
  webhookSweepRuns++;
  try {
    await deliverPendingWebhooks(supabase);
  } catch (err) {
    wlog.warn("Webhook delivery sweep failed (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    webhookSweepInFlight = false;
  }
}

/* ---- Graceful shutdown + signal/crash handlers ----
 * gracefulShutdown / SIGTERM / SIGINT / uncaughtException / unhandledRejection
 * live in worker/src/lib/lifecycle.ts. We pass closures over the entrypoint's
 * module-level state (active pools, timers, realtime channel) so the
 * extracted module can read/clear them without owning the state itself.
 */
const gracefulShutdown = makeGracefulShutdown({
  workerId: WORKER_ID,
  totalActiveJobs,
  allActiveJobIds,
  getRealtimeChannel: () => realtimeChannel,
  clearRealtimeChannel: () => { realtimeChannel = null; },
  getFallbackPollTimer: () => fallbackPollTimer,
  clearFallbackPollTimer: () => { fallbackPollTimer = null; },
  setShuttingDown: (v) => { isShuttingDown = v; },
  isShuttingDown: () => isShuttingDown,
  getTotalsSnapshot: () => ({ totalJobsProcessed, totalJobsFailed }),
});
registerProcessSignalHandlers(WORKER_ID, gracefulShutdown);

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
  webhookSweepRuns,
}));

console.log(
  `[Worker] MotionMax Render Worker started. ` +
  `Slots: export=${MAX_EXPORT_SLOTS} llm=${MAX_LLM_SLOTS} total=${MAX_CONCURRENT_JOBS}. ` +
  `Realtime + ${FALLBACK_POLL_INTERVAL_MS / 1000}s fallback poll.`
);
// Comprehensive startup banner — every external provider the worker
// can talk to. See worker/src/lib/providerKeysBanner.ts.
logProviderKeysBanner();

// Initial concurrency override read before any polling — picks up admin
// adjustments made while the worker was offline. Then keep polling every
// 60s for runtime tweaks.
pollConcurrencyOverride().then(() => {
  setInterval(pollConcurrencyOverride, 60_000);
});

// ── Phase 10.4 — worker heartbeat writer ────────────────────────────
// See worker/src/lib/heartbeat.ts. Polls worker_heartbeats.restart_requested
// each beat and triggers gracefulShutdown("ADMIN_RESTART") when the admin
// clicks Restart in TabPerformance.
const WORKER_STARTED_AT = new Date().toISOString();
startHeartbeatWriter({
  workerId: WORKER_ID,
  workerStartedAt: WORKER_STARTED_AT,
  totalActiveJobs,
  getMaxConcurrentJobs: () => MAX_CONCURRENT_JOBS,
  isShuttingDown: () => isShuttingDown,
  onRestartRequested: () => { void gracefulShutdown("ADMIN_RESTART"); },
});

// ── /api/v1 webhook delivery sweep loop (roadmap §Phase 2 — Webhooks) ───────
// Independent of the video_generation_jobs poll loop. Runs every ~15s, drains
// the webhook outbox (Builder A's deliverPendingWebhooks), overlap-guarded.
// Kicked off immediately so terminal webhooks enqueued during startup are
// delivered promptly rather than waiting a full interval.
void runWebhookSweep();
webhookSweepTimer = setInterval(() => { void runWebhookSweep(); }, WEBHOOK_SWEEP_INTERVAL_MS);
if (typeof webhookSweepTimer.unref === "function") webhookSweepTimer.unref();

runStartupDiagnostic(WORKER_ID).then((hadOrphans) => {
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

/* ---- Autopost: publish dispatcher + OAuth token refresher ----
 * Both run independently of the main video_generation_jobs poll loop.
 * They poll their own tables (autopost_publish_jobs, autopost_social_accounts)
 * and survive the global autopost_enabled kill switch in app_settings.
 * Wave 2c — stub publishers; Wave 3a swaps in real platform APIs.
 */
startAutopostDispatcher();
startTokenRefresher();
// Phase 14.3 + 15.3 — newsletter sender + scheduled-notification
// dispatcher. Both are independent polling loops on their own tables;
// they don't claim video_generation_jobs rows.
startNewsletterSender();
startScheduledNotificationDispatcher();
// Wave 4: daily summary report. Hourly tick, gated to fire at 09:00 UTC.
// Logs a structured summary entry per active user (no email transport yet).
startAutopostDailySummary();
