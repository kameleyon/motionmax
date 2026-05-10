/**
 * Stale-claim reaper. Extracted from worker/src/index.ts on 2026-05-10
 * (per audit C-4-3). Behavior preserved exactly: same SQL filters, same
 * windows, same log lines.
 *
 * Render redeploys SIGTERM the worker mid-job; the claim-RPC stamps
 * status='processing' but there's no heartbeat, so on restart those
 * jobs are zombies — finalize stays pending behind a depends_on chain
 * that will never resolve, and the autopost run sits at GENERATING 35 %
 * indefinitely.
 *
 * Once every ~1 min (12 polls @ 5 s), reset any 'processing' job whose
 * updated_at is older than its per-task-type stale window. The next
 * claim_pending_job RPC re-acquires it.
 *
 * ── Window sizing rationale (B-NEW-18 fix, 2026-05-10) ──────────────
 * Previous global window was 30 min. cinematic_video's hard timeout is
 * CINEMATIC_VIDEO_TIMEOUT_MS = 45 min and Hypereal's inner poll cap is
 * ~47 min — i.e. legit cinematic_video runtime strictly EXCEEDED the
 * reaper window. Result (2026-05-08 incident pattern): a still-running
 * cinematic_video job got reset to pending mid-Hypereal-poll, a sibling
 * worker re-claimed and submitted a SECOND Hypereal render, and both
 * the original worker and the sibling raced to write the scene URL —
 * double-spending Hypereal credits and producing non-deterministic
 * scene output.
 *
 * Fix: per-task-type stale windows that strictly dominate each task's
 * legitimate runtime ceiling, with comfortable headroom.
 *
 *   cinematic_video : 90 min  (2× the 45 min hard timeout — covers
 *                              Hypereal inner poll of 47 min and gives
 *                              2× P95 headroom per the audit spec)
 *   export_video    : 120 min (1.33× EXPORT_JOB_TIMEOUT_MS = 90 min;
 *                              ffmpeg + storage upload spike under
 *                              concurrent export load)
 *   default         : 90 min  (global floor — covers any future-added
 *                              long task we forgot to enumerate;
 *                              pure-LLM jobs still naturally fail at
 *                              LLM_JOB_TIMEOUT_MS = 15 min so the wider
 *                              reaper window just defers the cleanup,
 *                              it doesn't hide bugs)
 *
 * autopost_render / autopost_rerender keep their fail-closed policy
 * (any reap = mark failed). They run for up to 3.5 h legitimately, but
 * resuming them double-spends so we hold the line at 90 min and accept
 * a false-positive failure for any genuine orchestrator that happens
 * to take longer than 90 min. The orchestrator's own per-poll
 * heartbeat (handleAutopostRun heartbeatJob) keeps updated_at fresh
 * while it's actually alive.
 */
import { supabase } from "./supabase.js";
import { writeSystemLog } from "./logger.js";

const STALE_DEFAULT_MS         = 90 * 60 * 1000;   // 90 min global floor
const STALE_CINEMATIC_VIDEO_MS = 90 * 60 * 1000;   // 2× CINEMATIC_VIDEO_TIMEOUT_MS (45m)
const STALE_EXPORT_VIDEO_MS    = 120 * 60 * 1000;  // 1.33× EXPORT_JOB_TIMEOUT_MS (90m)
const STALE_ORCHESTRATOR_MS    = 90 * 60 * 1000;   // fail-closed cap

/** One pass of the reaper. Caller decides cadence (entrypoint runs it
 *  every 12 polls ≈ 1 min). Never throws — errors are logged. */
export async function runStaleClaimReaper(): Promise<void> {
  const nowMs = Date.now();
  const cutoffOrchestrator = new Date(nowMs - STALE_ORCHESTRATOR_MS).toISOString();
  const cutoffCinematic    = new Date(nowMs - STALE_CINEMATIC_VIDEO_MS).toISOString();
  const cutoffExport       = new Date(nowMs - STALE_EXPORT_VIDEO_MS).toISOString();
  const cutoffDefault      = new Date(nowMs - STALE_DEFAULT_MS).toISOString();

  // ── Fail-closed for autopost orchestrators ─────────────────────
  // autopost_render / autopost_rerender are non-idempotent: they
  // create projects, generate scripts, and submit child jobs. Re-
  // running from scratch on a stale-revive double-spends Hypereal
  // credits + LLM calls (verified 2026-05-08: a single revived
  // run produced two full Uruguay scripts + image/video batches).
  // Mark them failed instead so the user-visible run row stops
  // showing GENERATING and we don't burn a second pass of credits.
  // The handler's defensive check then catches any orchestrator
  // that slipped past this gate.
  const { data: orphanedOrchestrators, error: orchErr } = await supabase
    .from("video_generation_jobs")
    .update({
      status: "failed",
      error_message: "Orchestrator orphaned (worker died mid-pipeline). Failed-closed by stale-claim reaper to prevent duplicate spend on retry.",
    })
    .eq("status", "processing")
    .lt("updated_at", cutoffOrchestrator)
    .in("task_type", ["autopost_render", "autopost_rerender"])
    .select("id, task_type, payload");
  if (orchErr) {
    console.warn(`[Worker] Orchestrator fail-closed reaper error: ${orchErr.message}`);
  } else if (orphanedOrchestrators && orphanedOrchestrators.length > 0) {
    // Mirror the failure to autopost_runs so the dashboard updates.
    for (const j of orphanedOrchestrators as Array<{ payload: { autopost_run_id?: string } | null }>) {
      const runId = j?.payload?.autopost_run_id;
      if (typeof runId === "string") {
        await supabase.from("autopost_runs")
          .update({ status: "failed", error_summary: "Orchestrator orphaned by worker restart (refused to retry)", progress_pct: null })
          .eq("id", runId)
          .neq("status", "completed");
      }
    }
    console.warn(`[Worker] Failed-closed ${orphanedOrchestrators.length} orphaned orchestrator(s)`);
  }

  // ── Revive everything else ─────────────────────────────────────
  // Idempotent task types (cinematic_video has resume checkpoints,
  // image gen / TTS are single API calls that retry cleanly).
  // Per-task-type windows so we never reap a job that's still
  // legitimately running its hard timeout.
  const reaperBuckets: Array<{ taskTypes: string[] | null; cutoff: string; label: string; staleMin: number }> = [
    { taskTypes: ["cinematic_video"],                   cutoff: cutoffCinematic, label: "cinematic_video",  staleMin: STALE_CINEMATIC_VIDEO_MS / 60000 },
    { taskTypes: ["export_video"],                      cutoff: cutoffExport,    label: "export_video",     staleMin: STALE_EXPORT_VIDEO_MS    / 60000 },
    { taskTypes: null /* everything else, exclusive */, cutoff: cutoffDefault,   label: "default",          staleMin: STALE_DEFAULT_MS         / 60000 },
  ];

  for (const bucket of reaperBuckets) {
    let q = supabase
      .from("video_generation_jobs")
      .update({ status: "pending", worker_id: null })
      .eq("status", "processing")
      .lt("updated_at", bucket.cutoff);
    if (bucket.taskTypes && bucket.taskTypes.length > 0) {
      q = q.in("task_type", bucket.taskTypes);
    } else {
      // "default" bucket: anything that isn't an orchestrator and
      // isn't covered by a more-specific bucket above.
      q = q.not("task_type", "in", "(autopost_render,autopost_rerender,cinematic_video,export_video)");
    }
    const { data: reclaimed, error: reapErr } = await q.select("id, task_type");
    if (reapErr) {
      console.warn(`[Worker] Stale-claim reaper (${bucket.label}) failed: ${reapErr.message}`);
      continue;
    }
    if (reclaimed && reclaimed.length > 0) {
      const taskTypes = (reclaimed as Array<{ task_type: string }>).map((r) => r.task_type);
      console.warn(
        `[Worker] Stale-claim reaper revived ${reclaimed.length} zombie job(s) ` +
        `[bucket=${bucket.label}, staleAfterMin=${bucket.staleMin}] ` +
        `(types: ${[...new Set(taskTypes)].join(", ")}) — likely orphaned by a prior worker restart`,
      );
      await writeSystemLog({
        category: "system_warning",
        eventType: "stale_jobs_reaped",
        message: `Reset ${reclaimed.length} stale processing job(s) to pending [${bucket.label}]`,
        details: {
          bucket: bucket.label,
          count: reclaimed.length,
          taskTypes: [...new Set(taskTypes)],
          staleAfterMin: bucket.staleMin,
        },
      }).catch((e) => console.warn(`[Worker] reap log failed: ${(e as Error).message}`));
    }
  }
}
