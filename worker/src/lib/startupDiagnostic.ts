/**
 * Startup diagnostic — runs once at boot to verify DB connectivity and
 * rescue orphaned jobs from a previous worker incarnation.
 * Extracted from worker/src/index.ts on 2026-05-10 (per audit C-4-3).
 *
 * Tracks retries via payload._restartCount — after MAX_RESTART_RETRIES
 * restarts, marks the job as failed instead of looping forever.
 *
 * Returns true if orphaned jobs were recovered — caller may want to
 * apply a brief cooldown before its first poll to avoid an immediate
 * crash-restart-pick-up-crash loop.
 */
import { supabase } from "./supabase.js";

const MAX_RESTART_RETRIES = 3;

export async function runStartupDiagnostic(workerId: string): Promise<boolean> {
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
    //   (a) rows this exact worker_id previously claimed — same
    //       process restarting, or
    //   (b) ANY row stale-stuck for >10 min — covers orphans from
    //       a dead sibling replica or a previous Render instance
    //       that was killed mid-job (OOM, deploy SIGTERM, crash).
    // Sibling replicas update their jobs on every progress tick and
    // finalize completes within minutes, so a 10-min staleness gate
    // is well past any legit in-flight work — anything older is
    // orphaned regardless of which worker_id is stamped on it.
    //
    // This was the root cause of the 2026-05-04 OOM-restart loop:
    // the previous filter only matched rows the *current* worker_id
    // had touched, so jobs orphaned by an OOM'd predecessor (with a
    // different worker_id) sat as zombies forever, the per-job
    // _restartCount never incremented, and MAX_RESTART_RETRIES never
    // tripped to fail the offending job.
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: processingRows } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, payload, created_at, updated_at")
      .eq("status", "processing")
      .or(`worker_id.eq.${workerId},updated_at.lt.${staleThreshold}`)
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
