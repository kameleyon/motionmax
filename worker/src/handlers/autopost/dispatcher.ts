/**
 * Autopost publish dispatcher.
 *
 * Polls autopost_publish_jobs every 5s, claims pending rows that are due
 * (scheduled_for <= now), and fans out to per-platform publishers. Uses
 * polling intentionally — the rest of this worker uses polling on
 * video_generation_jobs and we want a single operational pattern. No
 * LISTEN/NOTIFY, no node-postgres dep.
 *
 * Concurrency:
 *   - At most MAX_CONCURRENT_PUBLISHES jobs in flight per worker.
 *   - In-memory inFlight set deduplicates within a process.
 *   - DB-side claim (status pending -> uploading + attempts++) is the
 *     authoritative dedupe across worker replicas: only one worker wins.
 *
 * Restart safety:
 *   - On startup, any 'uploading' rows whose last_attempt_at is older than
 *     STALE_UPLOADING_MS are reset to 'pending' so a crashed prior worker
 *     does not strand them. This runs once at startup.
 *
 * Retry:
 *   - Driven by retryPolicy.retryDelayMs(). On retryable failures with
 *     attempts < MAX_PUBLISH_ATTEMPTS we set status='pending' +
 *     scheduled_for=now+delay. On non-retryable or final attempt we set
 *     status='failed' + error_code + error_message.
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";
import { publishYouTube, publishInstagram, publishTikTok } from "./publishers.js";
import { retryDelayMs, MAX_PUBLISH_ATTEMPTS } from "./retryPolicy.js";
import { generateAutopostThumbnail } from "./thumbnails.js";
import { refreshAccountToken } from "./tokenRefresh.js";
import type { Platform, PublishContext, PublishJob, PublishResult, SocialAccount } from "./types.js";

const POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_PUBLISHES = 4;
/** uploading rows older than this on startup are considered orphaned and reset. */
const STALE_UPLOADING_MS = 30 * 60_000;
/**
 * Hard ceiling for an autopost render. Cinematic mode with Kling 3.0
 * Pro image-to-video can legitimately take 60–90 minutes for longer
 * scripts (each scene = 60–600s of Kling polling, run sequentially
 * inside the cinematic_video pool). 1 hour was killing live runs that
 * were still polling Kling. 3 hours is the new outer bound — past
 * that the render is almost certainly stuck.
 */
const STALLED_RUN_MS = 3 * 60 * 60_000;
/**
 * Stale threshold for `queued` runs that never got picked up by the worker.
 * autopost_tick + autopost_fire_now insert the run as 'queued' and immediately
 * flip to 'generating' once the render-job row exists. A 'queued' row that
 * survives more than 2 h means the render job was never inserted (DB error,
 * crash mid-RPC) and the row will sit forever otherwise.
 */
const STALLED_QUEUED_RUN_MS = 2 * 60 * 60_000;
/**
 * Activity heartbeat. Even within the hard ceiling, mark a run failed
 * only if its underlying video_generation_jobs row hasn't been touched
 * for this long. Each phase handler bumps `updated_at` on its job row,
 * so a healthy in-progress render heartbeats every couple of minutes.
 * 30 minutes of silence is much longer than any single phase should
 * take and reliably indicates a genuine stall.
 */
const STALLED_RUN_HEARTBEAT_MS = 30 * 60_000;
/** Throttle interval for cleanupStalledRuns — runs at most every ~minute. */
const STALLED_CLEANUP_INTERVAL_MS = 60_000;

let running = false;
const inFlight = new Set<string>();
let lastStalledCleanupAt = 0;

export function startAutopostDispatcher(): void {
  if (running) return;
  running = true;
  // One-shot startup cleanup, then enter the regular tick loop.
  void resetStaleUploading().finally(() => {
    setInterval(tick, POLL_INTERVAL_MS);
    void tick();
  });
}

/** Reset rows stuck in 'uploading' from a prior crashed worker. */
async function resetStaleUploading(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STALE_UPLOADING_MS).toISOString();
    const { data, error } = await supabase
      .from("autopost_publish_jobs")
      .update({ status: "pending" })
      .eq("status", "uploading")
      .lt("last_attempt_at", cutoff)
      .select("id");

    if (error) {
      console.warn(`[Autopost] stale uploading reset failed: ${error.message}`);
      return;
    }
    if (data && data.length > 0) {
      console.log(`[Autopost] reset ${data.length} stale uploading row(s) to pending`);
      await writeSystemLog({
        category: "system_info",
        eventType: "autopost_stale_uploading_reset",
        message: `Reset ${data.length} stale uploading publish job(s)`,
        details: { count: data.length, ids: data.map((r: { id: string }) => r.id) },
      });
    }
  } catch (e) {
    console.warn(`[Autopost] stale uploading reset exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readGlobalEnabled(): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "autopost_enabled")
      .maybeSingle();
    if (!data) return false;
    const v = (data as { value: unknown }).value;
    if (v === true) return true;
    if (typeof v === "string") return v === "true";
    return false;
  } catch {
    return false;
  }
}

async function readPlatformEnabled(platform: Platform): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", `autopost_${platform}_enabled`)
      .maybeSingle();
    if (!data) return true; // default-on if missing
    const v = (data as { value: unknown }).value;
    if (v === true) return true;
    if (v === false) return false;
    if (typeof v === "string") return v !== "false";
    return true;
  } catch {
    return true;
  }
}

async function tick(): Promise<void> {
  try {
    // GLOBAL kill switch: read BEFORE any DB query so flipping the switch
    // immediately quiesces this worker. Note that the per-tick poll itself
    // is also a DB query; we accept that tradeoff because the switch read
    // is a single-row maybeSingle() against an indexed key.
    const enabled = await readGlobalEnabled();
    if (!enabled) return;

    // Throttled stalled-run cleanup: piggyback on the 5s tick but only
    // actually run the work once per minute. Doing this here means we
    // don't need a second setInterval and the cadence stays cheap.
    if (Date.now() - lastStalledCleanupAt >= STALLED_CLEANUP_INTERVAL_MS) {
      lastStalledCleanupAt = Date.now();
      void cleanupStalledRuns().catch((e) => {
        console.warn(`[Autopost] stalled-run cleanup exception: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    const slots = MAX_CONCURRENT_PUBLISHES - inFlight.size;
    if (slots <= 0) return;

    const nowIso = new Date().toISOString();
    const { data: jobs, error } = await supabase
      .from("autopost_publish_jobs")
      .select("*")
      .eq("status", "pending")
      .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
      .order("scheduled_for", { ascending: true, nullsFirst: true })
      .limit(slots);

    if (error) {
      console.warn(`[Autopost] dispatcher poll failed: ${error.message}`);
      return;
    }
    if (!jobs || jobs.length === 0) return;

    for (const row of jobs as PublishJob[]) {
      if (inFlight.has(row.id)) continue;
      inFlight.add(row.id);
      void processJob(row).finally(() => inFlight.delete(row.id));
    }
  } catch (err) {
    console.error(`[Autopost] tick exception: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processJob(rowFromPoll: PublishJob): Promise<void> {
  // 1. Atomic claim.
  // The .eq("status", "pending") in WHERE makes this safe across replicas:
  // only the first worker to update the row wins; the others get 0 rows.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("autopost_publish_jobs")
    .update({
      status: "uploading",
      attempts: rowFromPoll.attempts + 1,
      last_attempt_at: claimedAt,
    })
    .eq("id", rowFromPoll.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (claimErr) {
    console.warn(`[Autopost] claim failed for ${rowFromPoll.id}: ${claimErr.message}`);
    return;
  }
  if (!claimed) {
    // Lost the race; another worker took it.
    return;
  }

  const job = claimed as PublishJob;
  const platform = job.platform;

  // 2. Per-platform kill switch.
  const platformEnabled = await readPlatformEnabled(platform);
  if (!platformEnabled) {
    const next = new Date(Date.now() + 10 * 60_000).toISOString();
    await supabase
      .from("autopost_publish_jobs")
      .update({
        status: "pending",
        // Step attempts back so this skip doesn't burn the retry budget.
        attempts: job.attempts,
        scheduled_for: next,
      })
      .eq("id", job.id);
    await writeSystemLog({
      jobId: job.id,
      category: "system_info",
      eventType: "autopost_platform_disabled",
      message: `Skipped publish job ${job.id} — ${platform} kill switch is off; rescheduled +10min`,
      details: { jobId: job.id, platform },
    });
    return;
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_info",
    eventType: "autopost_publish_started",
    message: `Publish job ${job.id} (${platform}) started, attempt ${job.attempts}`,
    details: { jobId: job.id, platform, attempts: job.attempts, runId: job.run_id },
  });

  // 3. Load social account.
  const { data: acctRow, error: acctErr } = await supabase
    .from("autopost_social_accounts")
    .select("*")
    .eq("id", job.social_account_id)
    .maybeSingle();

  if (acctErr || !acctRow) {
    // Edge case 4a: stale target_account_id was carried into a publish_job,
    // most likely because the user disconnected the account between
    // schedule create and run fan-out. Surface as a clean code rather
    // than crashing or retrying — the row is permanently broken.
    await markFailed(job, "account_not_found", `Social account ${job.social_account_id} not found`);
    return;
  }
  let account = acctRow as SocialAccount;
  if (account.status !== "connected") {
    await markFailed(job, "account_not_connected", `Account status is ${account.status}`);
    return;
  }

  // 4. Load run + video URL + caption.
  const { data: runRow, error: runErr } = await supabase
    .from("autopost_runs")
    .select("id, schedule_id, video_job_id")
    .eq("id", job.run_id)
    .maybeSingle();

  if (runErr || !runRow) {
    await markFailed(job, "run_missing", `Autopost run ${job.run_id} not found`);
    return;
  }

  let videoUrl = "";
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let videoDurationMs: number | undefined;
  let videoSizeBytes: number | undefined;

  if (runRow.video_job_id) {
    const { data: vidJob } = await supabase
      .from("video_generation_jobs")
      .select("payload, result")
      .eq("id", runRow.video_job_id)
      .maybeSingle();
    if (vidJob) {
      const payload =
        (vidJob as {
          payload?:
            | {
                finalUrl?: string;
                width?: number;
                height?: number;
                durationMs?: number;
                durationSeconds?: number;
                sizeBytes?: number;
              }
            | null;
        }).payload ?? null;
      const result =
        (vidJob as {
          result?:
            | {
                finalUrl?: string;
                width?: number;
                height?: number;
                durationMs?: number;
                durationSeconds?: number;
                sizeBytes?: number;
              }
            | null;
        }).result ?? null;
      videoUrl = result?.finalUrl ?? payload?.finalUrl ?? "";
      videoWidth = result?.width ?? payload?.width;
      videoHeight = result?.height ?? payload?.height;
      const dms = result?.durationMs ?? payload?.durationMs;
      const dsec = result?.durationSeconds ?? payload?.durationSeconds;
      videoDurationMs = dms ?? (typeof dsec === "number" ? Math.round(dsec * 1000) : undefined);
      videoSizeBytes = result?.sizeBytes ?? payload?.sizeBytes;
    }
  }

  if (!videoUrl) {
    await markFailed(job, "video_url_missing", "No finalUrl found on the linked video_generation_jobs row");
    return;
  }

  // If finalUrl looks like a storage path rather than a full URL, sign it.
  // Publishers (esp. IG, which fetches the URL server-side) need a public
  // or signed URL; a bare "exports/foo.mp4" path won't work.
  videoUrl = await ensureFetchableVideoUrl(videoUrl);

  // Opportunistic thumbnail generation: fire-and-forget so we don't
  // delay the publish. The function self-guards with WHERE thumbnail_url
  // IS NULL so we won't double-generate when multiple sibling publish
  // jobs (one per platform) all hit this path. Failure is logged inside
  // and never thrown — the run is still considered successful even if
  // we can't make a poster frame.
  void generateAutopostThumbnail(job.run_id, videoUrl).catch(() => undefined);

  // Caption: prefer per-job caption, fall back to schedule caption_template.
  let caption = job.caption ?? "";
  if (!caption) {
    const { data: schedRow } = await supabase
      .from("autopost_schedules")
      .select("caption_template")
      .eq("id", runRow.schedule_id)
      .maybeSingle();
    caption = (schedRow as { caption_template?: string } | null)?.caption_template ?? "";
  }

  // 5. Dispatch to platform.
  const ctx: PublishContext = {
    job,
    account,
    videoUrl,
    caption,
    runId: job.run_id,
    width: videoWidth,
    height: videoHeight,
    durationMs: videoDurationMs,
    sizeBytes: videoSizeBytes,
  };

  let result: PublishResult;
  try {
    result = await dispatchToPublisher(platform, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { ok: false, errorCode: "publisher_exception", errorMessage: msg, retryable: true };
  }

  // Edge case 4c: token revoked / expired at the provider while we were
  // mid-flight. Refresh inline ONCE and retry without burning a queue
  // round-trip — a queued retry would just hit the same stale token
  // because token-refresh runs on a 5min cadence. We only attempt this
  // on the FIRST claim of a job (attempts === 1 after the claim bump);
  // a second token_expired after a fresh refresh genuinely means the
  // user revoked us, so let the retry policy take over.
  if (!result.ok && result.errorCode === "token_expired" && job.attempts <= 1) {
    const refreshed = await refreshAccountToken(account.id).catch((e) => {
      console.warn(`[Autopost] inline token refresh failed for ${account.id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (refreshed) {
      account = refreshed;
      const refreshedCtx: PublishContext = { ...ctx, account };
      await writeSystemLog({
        jobId: job.id,
        category: "system_info",
        eventType: "autopost_inline_token_refreshed",
        message: `Inline token refresh succeeded for ${platform} account ${account.id}; retrying publish`,
        details: { jobId: job.id, accountId: account.id, platform },
      });
      try {
        result = await dispatchToPublisher(platform, refreshedCtx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result = { ok: false, errorCode: "publisher_exception", errorMessage: msg, retryable: true };
      }
    }
  }

  // 6. Persist outcome + roll-up the platform metric.
  //
  // We roll up metrics only on TERMINAL outcomes (published / failed final
  // attempt). Mid-stream retries report as 'retried' so the daily summary
  // can distinguish "this user is hitting rate limits all day" from
  // "this user has 5 healthy posts and 0 failures."
  if (result.ok) {
    await markPublished(job, result.postId, result.postUrl);
    await recordPublishOutcome(platform, account.user_id, "succeeded");
    await maybeCompleteRun(job.run_id);
  } else {
    const willRetry =
      result.retryable && job.attempts < MAX_PUBLISH_ATTEMPTS && retryDelayMs(job.attempts) !== null;
    await handleFailure(job, result);
    if (willRetry) {
      await recordPublishOutcome(platform, account.user_id, "retried");
    } else {
      await recordPublishOutcome(platform, account.user_id, "failed");
    }
  }
}

async function dispatchToPublisher(platform: Platform, ctx: PublishContext): Promise<PublishResult> {
  switch (platform) {
    case "youtube":
      return publishYouTube(ctx);
    case "instagram":
      return publishInstagram(ctx);
    case "tiktok":
      return publishTikTok(ctx);
    default:
      return {
        ok: false,
        errorCode: "unknown_platform",
        errorMessage: `Unknown platform: ${platform}`,
        retryable: false,
      };
  }
}

async function markPublished(job: PublishJob, postId: string, postUrl: string): Promise<void> {
  const { error } = await supabase
    .from("autopost_publish_jobs")
    .update({
      status: "published",
      platform_post_id: postId,
      platform_post_url: postUrl,
      error_code: null,
      error_message: null,
    })
    .eq("id", job.id);

  if (error) {
    console.warn(`[Autopost] markPublished update failed for ${job.id}: ${error.message}`);
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_info",
    eventType: "autopost_publish_succeeded",
    message: `Publish job ${job.id} (${job.platform}) published as ${postId}`,
    details: { jobId: job.id, platform: job.platform, postId, postUrl, runId: job.run_id },
  });
}

async function markFailed(job: PublishJob, code: string, message: string): Promise<void> {
  const { error } = await supabase
    .from("autopost_publish_jobs")
    .update({
      status: "failed",
      error_code: code,
      error_message: message,
    })
    .eq("id", job.id);

  if (error) {
    console.warn(`[Autopost] markFailed update failed for ${job.id}: ${error.message}`);
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_error",
    eventType: "autopost_publish_failed",
    message: `Publish job ${job.id} (${job.platform}) failed: ${code} — ${message}`,
    details: { jobId: job.id, platform: job.platform, errorCode: code, runId: job.run_id, attempts: job.attempts },
  });

  await maybeCompleteRun(job.run_id);
}

async function handleFailure(
  job: PublishJob,
  result: Extract<PublishResult, { ok: false }>,
): Promise<void> {
  const attemptsSoFar = job.attempts; // already incremented during claim
  const canRetry =
    result.retryable && attemptsSoFar < MAX_PUBLISH_ATTEMPTS;

  if (!canRetry) {
    await markFailed(job, result.errorCode, result.errorMessage);
    return;
  }

  // Compute next delay. retryDelayMs takes attemptsSoFar; we've already
  // done `attemptsSoFar` tries (so next is attemptsSoFar+1), but the
  // function's contract is "delay BEFORE next attempt given how many
  // already happened" — pass attemptsSoFar directly.
  const baseDelay = retryDelayMs(attemptsSoFar);
  if (baseDelay === null) {
    await markFailed(job, result.errorCode, result.errorMessage);
    return;
  }
  const delay = result.retryAfterMs && result.retryAfterMs > baseDelay ? result.retryAfterMs : baseDelay;
  const next = new Date(Date.now() + delay).toISOString();

  const { error } = await supabase
    .from("autopost_publish_jobs")
    .update({
      status: "pending",
      scheduled_for: next,
      error_code: result.errorCode,
      error_message: result.errorMessage,
    })
    .eq("id", job.id);

  if (error) {
    console.warn(`[Autopost] retry reschedule failed for ${job.id}: ${error.message}`);
  }

  await writeSystemLog({
    jobId: job.id,
    category: "system_warning",
    eventType: "autopost_publish_retry_scheduled",
    message: `Publish job ${job.id} (${job.platform}) retry #${attemptsSoFar + 1} scheduled at ${next}`,
    details: {
      jobId: job.id,
      platform: job.platform,
      errorCode: result.errorCode,
      attempts: attemptsSoFar,
      delayMs: delay,
      runId: job.run_id,
    },
  });
}

/**
 * Make sure the videoUrl we hand to a platform publisher is something an
 * external service (especially Instagram, which server-side-fetches) can
 * actually GET. Three cases handled:
 *   1. Already a full http(s) URL → returned unchanged.
 *   2. A bare storage path like "videos/exports/foo.mp4" or
 *      "exports/foo.mp4" → signed against the appropriate bucket for 1h.
 *   3. Anything else → returned unchanged; the publisher will fail and the
 *      retry path will surface the error.
 */
async function ensureFetchableVideoUrl(raw: string): Promise<string> {
  if (!raw) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

  // Heuristic: if the path starts with a known bucket prefix, split off
  // the bucket. Otherwise default to the "videos" bucket which is where
  // exports/ lives.
  const knownBuckets = ["videos", "scene-videos", "scene-images", "audio"];
  let bucket = "videos";
  let path = raw;
  for (const b of knownBuckets) {
    if (raw.startsWith(`${b}/`)) {
      bucket = b;
      path = raw.slice(b.length + 1);
      break;
    }
  }

  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) {
      console.warn(`[Autopost] could not sign storage path "${raw}": ${error?.message ?? "unknown"}`);
      return raw;
    }
    return data.signedUrl;
  } catch (e) {
    console.warn(`[Autopost] sign exception for "${raw}": ${e instanceof Error ? e.message : String(e)}`);
    return raw;
  }
}

/**
 * Daily-bucketed roll-up of publish outcomes. Keyed by (platform, user, date)
 * with UPSERT semantics — the table has UNIQUE (platform, user_id, bucket).
 *
 * Outcomes:
 *   - 'succeeded' increments succeeded + total_attempts
 *   - 'failed'    increments failed    + total_attempts (terminal failure)
 *   - 'retried'   increments retried   + total_attempts (mid-flight, will retry)
 *
 * The supabase-js client doesn't expose Postgres' atomic increment, so we
 * do read-modify-write. For low publish volume (single-digit per minute)
 * this is fine; if we ever see contention we'd switch to a SECURITY DEFINER
 * RPC that does the increment in one statement.
 */
async function recordPublishOutcome(
  platform: Platform,
  userId: string,
  outcome: "succeeded" | "failed" | "retried",
): Promise<void> {
  try {
    // UTC date so the bucket key is timezone-stable across worker hosts.
    const bucket = new Date().toISOString().slice(0, 10);

    const { data: existing, error: readErr } = await supabase
      .from("autopost_platform_metrics")
      .select("id, succeeded, failed, retried, total_attempts")
      .eq("platform", platform)
      .eq("user_id", userId)
      .eq("bucket", bucket)
      .maybeSingle();

    if (readErr) {
      console.warn(`[Autopost] metrics read failed: ${readErr.message}`);
      return;
    }

    const inc = {
      succeeded: outcome === "succeeded" ? 1 : 0,
      failed: outcome === "failed" ? 1 : 0,
      retried: outcome === "retried" ? 1 : 0,
    };

    if (existing) {
      const { error: updErr } = await supabase
        .from("autopost_platform_metrics")
        .update({
          succeeded: (existing as { succeeded: number }).succeeded + inc.succeeded,
          failed: (existing as { failed: number }).failed + inc.failed,
          retried: (existing as { retried: number }).retried + inc.retried,
          total_attempts: (existing as { total_attempts: number }).total_attempts + 1,
        })
        .eq("id", (existing as { id: string }).id);
      if (updErr) console.warn(`[Autopost] metrics update failed: ${updErr.message}`);
    } else {
      const { error: insErr } = await supabase
        .from("autopost_platform_metrics")
        .insert({
          platform,
          user_id: userId,
          bucket,
          succeeded: inc.succeeded,
          failed: inc.failed,
          retried: inc.retried,
          total_attempts: 1,
        });
      // Possible race: two concurrent inserts produce a unique-violation.
      // Retry as an update once if that happens.
      if (insErr) {
        const msg = insErr.message ?? "";
        if (/duplicate key|unique/i.test(msg)) {
          await recordPublishOutcome(platform, userId, outcome);
          return;
        }
        console.warn(`[Autopost] metrics insert failed: ${msg}`);
      }
    }
  } catch (e) {
    console.warn(`[Autopost] recordPublishOutcome exception: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Edge case 4b: an autopost render that takes longer than STALLED_RUN_MS is
 * almost certainly never going to finish. Mark the run failed and surface
 * a clean error so the run history doesn't show a permanent "generating"
 * row that confuses the operator.
 *
 * We only touch runs in 'generating' (the state set right after the video
 * job is enqueued and before the render-completed trigger flips it). 'queued'
 * is a transient state that the tick clears within seconds, and 'rendered' /
 * 'publishing' / 'completed' are post-render terminal-ish states that the
 * publish_jobs path owns.
 */
async function cleanupStalledRuns(): Promise<void> {
  const ceiling = new Date(Date.now() - STALLED_RUN_MS).toISOString();
  const heartbeat = new Date(Date.now() - STALLED_RUN_HEARTBEAT_MS).toISOString();

  // Find candidates: 'generating' runs older than the hard ceiling.
  const { data: oldRuns, error: oldErr } = await supabase
    .from("autopost_runs")
    .select("id, video_job_id, fired_at")
    .eq("status", "generating")
    .lt("fired_at", ceiling);
  if (oldErr) {
    console.warn(`[Autopost] cleanupStalledRuns query failed: ${oldErr.message}`);
    return;
  }
  if (!oldRuns || oldRuns.length === 0) return;

  // Of those, only mark failed the ones whose underlying render job
  // has been silent for STALLED_RUN_HEARTBEAT_MS. Each phase handler
  // bumps video_generation_jobs.updated_at, so a still-progressing
  // run (e.g., Kling i2v polling for 90 minutes) survives this sweep
  // even though its run row is older than the hard ceiling.
  const stalledIds: string[] = [];
  for (const r of oldRuns as Array<{ id: string; video_job_id: string | null; fired_at: string }>) {
    if (!r.video_job_id) {
      // No render job linked — orphaned. Definitely stalled.
      stalledIds.push(r.id);
      continue;
    }
    const { data: jobRow } = await supabase
      .from("video_generation_jobs")
      .select("status, updated_at")
      .eq("id", r.video_job_id)
      .maybeSingle();
    const status = (jobRow as { status?: string } | null)?.status ?? null;
    const updatedAt = (jobRow as { updated_at?: string } | null)?.updated_at ?? r.fired_at;
    // If the job is already terminal (completed/failed) but the run
    // didn't transition, the trigger will catch up. Skip.
    if (status === "completed" || status === "failed") continue;
    // If the worker has bumped updated_at recently, the render is
    // alive — give it more time.
    if (updatedAt > heartbeat) continue;
    stalledIds.push(r.id);
  }

  if (stalledIds.length === 0) return;

  const { data, error } = await supabase
    .from("autopost_runs")
    .update({
      status: "failed",
      error_summary: "Render stalled (no progress for 30+ minutes)",
    })
    .in("id", stalledIds)
    .select("id");

  if (error) {
    console.warn(`[Autopost] cleanupStalledRuns update failed: ${error.message}`);
    return;
  }
  if (data && data.length > 0) {
    console.log(`[Autopost] marked ${data.length} stalled run(s) as failed`);
    await writeSystemLog({
      category: "system_warning",
      eventType: "autopost_run_stalled_timeout",
      message: `Marked ${data.length} stalled autopost run(s) as failed (no heartbeat in ${Math.round(STALLED_RUN_HEARTBEAT_MS / 60_000)}min, ceiling ${Math.round(STALLED_RUN_MS / 3_600_000)}h)`,
      details: { count: data.length, ids: data.map((r: { id: string }) => r.id) },
    });
  }

  // ── Stalled-queued sweep ─────────────────────────────────────────
  // A run row stuck in 'queued' for >2 h with no matching
  // video_generation_jobs row (or with a video_job_id pointing at a
  // row that no longer exists) is unrecoverable — the watchdog above
  // only handles 'generating'.
  const queuedCutoff = new Date(Date.now() - STALLED_QUEUED_RUN_MS).toISOString();
  const { data: queuedRuns, error: queuedErr } = await supabase
    .from("autopost_runs")
    .select("id, video_job_id, fired_at")
    .eq("status", "queued")
    .lt("fired_at", queuedCutoff);
  if (queuedErr) {
    console.warn(`[Autopost] cleanupStalledRuns queued query failed: ${queuedErr.message}`);
    return;
  }
  if (!queuedRuns || queuedRuns.length === 0) return;

  const orphanIds: string[] = [];
  for (const r of queuedRuns as Array<{ id: string; video_job_id: string | null; fired_at: string }>) {
    if (!r.video_job_id) {
      orphanIds.push(r.id);
      continue;
    }
    const { data: jobRow } = await supabase
      .from("video_generation_jobs")
      .select("id, status")
      .eq("id", r.video_job_id)
      .maybeSingle();
    // No matching job row → orphaned.
    if (!jobRow) orphanIds.push(r.id);
  }

  if (orphanIds.length === 0) return;

  const { data: queuedKilled, error: killErr } = await supabase
    .from("autopost_runs")
    .update({
      status: "failed",
      error_summary: "Run never picked up by worker (no render job)",
    })
    .in("id", orphanIds)
    .select("id");

  if (killErr) {
    console.warn(`[Autopost] cleanupStalledRuns queued sweep failed: ${killErr.message}`);
    return;
  }
  if (queuedKilled && queuedKilled.length > 0) {
    console.log(`[Autopost] marked ${queuedKilled.length} orphan queued run(s) as failed`);
    await writeSystemLog({
      category: "system_warning",
      eventType: "autopost_run_stalled_queued",
      message: `Marked ${queuedKilled.length} orphan queued autopost run(s) as failed (>${Math.round(STALLED_QUEUED_RUN_MS / 3_600_000)}h with no render job)`,
      details: { count: queuedKilled.length, ids: queuedKilled.map((r: { id: string }) => r.id) },
    });
  }
}

/**
 * If every sibling publish_job for this run is now in a terminal state
 * ('published' | 'failed' | 'rejected'), flip the run to 'completed'.
 * We use 'completed' regardless of mixed success — the per-job rows hold
 * the per-platform truth. autopost_runs.status_summary fields could be
 * added later if richer reporting is needed.
 */
async function maybeCompleteRun(runId: string): Promise<void> {
  try {
    const { data: siblings, error } = await supabase
      .from("autopost_publish_jobs")
      .select("status")
      .eq("run_id", runId);

    if (error || !siblings) return;

    const allDone = siblings.every((r: { status: string }) =>
      r.status === "published" || r.status === "failed" || r.status === "rejected",
    );
    if (!allDone) return;

    await supabase
      .from("autopost_runs")
      .update({ status: "completed" })
      .eq("id", runId)
      .neq("status", "completed");
  } catch (e) {
    console.warn(`[Autopost] maybeCompleteRun exception for ${runId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
