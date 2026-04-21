/**
 * Per-scene progress tracking for video_generation_jobs.
 *
 * Writes structured progress data into the job's payload.sceneProgress
 * field so both the worker and frontend can track individual scene status
 * across all pipeline phases (image generation, audio generation, export).
 *
 * No database migration needed — uses existing JSONB payload column.
 */
import { supabase, WORKER_SUPABASE_URL, WORKER_SUPABASE_KEY } from "./supabase.js";

/**
 * POST directly to Supabase Realtime's REST broadcast endpoint.
 *
 * This is the same call `channel.httpSend()` makes in supabase-js 2.50+,
 * reimplemented so the worker (on 2.45.6) can broadcast progress without
 * triggering the "Realtime send() is automatically falling back to REST
 * API" deprecation warning that `channel().send()` emits.
 *
 * Fire-and-forget — callers should NOT await this; a failed broadcast
 * must never stall a generation.
 */
async function broadcastProgress(
  jobId: string,
  progress: JobSceneProgress,
): Promise<void> {
  const url = `${WORKER_SUPABASE_URL}/realtime/v1/api/broadcast`;
  const body = {
    messages: [
      {
        topic: `job-progress-${jobId}`,
        event: "progress",
        payload: { jobId, sceneProgress: progress },
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: WORKER_SUPABASE_KEY,
      Authorization: `Bearer ${WORKER_SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // 202 Accepted is the happy path; other statuses we simply swallow
  // because broadcasts are best-effort (the client polls every 5s anyway).
  if (!res.ok && res.status !== 202) {
    console.warn(`[SceneProgress] Broadcast HTTP ${res.status} for job ${jobId} — client will catch up on next poll`);
  }
}

// ── Types ────────────────────────────────────────────────────────────

export type ScenePhase =
  | "pending"
  | "downloading"
  | "encoding"
  | "generating"
  | "uploading"
  | "complete"
  | "failed"
  | "skipped"
  | "timeout";

export interface SceneProgressEntry {
  /** 0-based scene index */
  sceneIndex: number;
  /** Current phase of this scene */
  phase: ScenePhase;
  /** ISO timestamp when this scene started processing */
  startedAt?: string;
  /** ISO timestamp when this scene finished */
  completedAt?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Error message if failed */
  error?: string;
  /** Human-readable status message */
  message?: string;
}

export interface JobSceneProgress {
  /** Total number of scenes in this job */
  totalScenes: number;
  /** Number of scenes fully completed */
  completedScenes: number;
  /** 0-based index of the scene currently being processed (-1 if none) */
  currentSceneIndex: number;
  /** High-level phase of the overall job */
  overallPhase: string;
  /** Human-readable status message for the overall job */
  overallMessage: string;
  /** Per-scene status entries */
  scenes: SceneProgressEntry[];
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Estimated seconds remaining (0 if unknown) */
  etaSeconds: number;
}

// ── State ────────────────────────────────────────────────────────────

/** In-memory scene progress per job — avoids redundant DB reads */
const progressCache = new Map<string, JobSceneProgress>();

/**
 * Per-job flush queue — serializes concurrent flushSceneProgress calls so
 * only one UPDATE is in-flight per jobId at a time. Eliminates the
 * read-modify-write race where two concurrent flushes clobber each other's
 * sceneProgress by both reading the same stale payload and overwriting it.
 */
const flushQueue = new Map<string, Promise<void>>();

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initialize scene progress tracking for a job.
 * Call this once at the start of a multi-scene phase (images, audio, export).
 */
export function initSceneProgress(
  jobId: string,
  totalScenes: number,
  overallPhase: string
): JobSceneProgress {
  const progress: JobSceneProgress = {
    totalScenes,
    completedScenes: 0,
    currentSceneIndex: -1,
    overallPhase,
    overallMessage: `Starting ${overallPhase}...`,
    scenes: Array.from({ length: totalScenes }, (_, i) => ({
      sceneIndex: i,
      phase: "pending" as ScenePhase,
    })),
    updatedAt: new Date().toISOString(),
    etaSeconds: 0,
  };

  progressCache.set(jobId, progress);
  return progress;
}

/**
 * Update the progress for a specific scene within a job.
 * Automatically recalculates completedScenes, ETA, and overall message.
 */
export async function updateSceneProgress(
  jobId: string,
  sceneIndex: number,
  phase: ScenePhase,
  options: {
    message?: string;
    error?: string;
    /** If true, also write the progress to the DB immediately */
    flush?: boolean;
  } = {}
): Promise<void> {
  let progress = progressCache.get(jobId);
  if (!progress) return;

  const entry = progress.scenes[sceneIndex];
  if (!entry) return;

  const now = new Date().toISOString();

  // Update phase
  entry.phase = phase;
  if (options.message) entry.message = options.message;
  if (options.error) entry.error = options.error;

  // Track timing
  if (phase !== "pending" && !entry.startedAt) {
    entry.startedAt = now;
  }
  if (phase === "complete" || phase === "failed" || phase === "skipped" || phase === "timeout") {
    entry.completedAt = now;
    if (entry.startedAt) {
      entry.durationMs = new Date(now).getTime() - new Date(entry.startedAt).getTime();
    }
  }

  // Recalculate aggregates
  progress.currentSceneIndex = sceneIndex;
  progress.completedScenes = progress.scenes.filter(
    (s) => s.phase === "complete" || s.phase === "skipped"
  ).length;
  progress.updatedAt = now;

  // Calculate ETA from completed scene durations
  const completedWithDuration = progress.scenes.filter(
    (s) => s.phase === "complete" && s.durationMs && s.durationMs > 0
  );
  if (completedWithDuration.length > 0) {
    const avgDurationMs =
      completedWithDuration.reduce((sum, s) => sum + (s.durationMs || 0), 0) /
      completedWithDuration.length;
    const remaining = progress.totalScenes - progress.completedScenes;
    progress.etaSeconds = Math.round((avgDurationMs * remaining) / 1000);
  }

  // Build overall message
  const failedCount = progress.scenes.filter((s) => s.phase === "failed" || s.phase === "timeout").length;
  progress.overallMessage = buildOverallMessage(progress, failedCount);

  if (options.flush !== false) {
    await flushSceneProgress(jobId);
  }
}

/**
 * Write the current scene progress to the database.
 *
 * Calls are serialized per jobId via a flush queue — if a flush is already
 * in-flight for this job, the new call chains onto it. This eliminates the
 * read-modify-write race where two concurrent callers both read the same
 * stale payload row, patch it independently, and overwrite each other.
 *
 * The UPDATE uses a JSONB merge expression so it never needs to read first:
 * `payload = payload || '{"sceneProgress": ...}'::jsonb`
 * Supabase JS doesn't expose raw SQL operators, so we use an RPC wrapper.
 * Fallback: if the RPC is unavailable we use the read-modify-write path
 * (safe here because the flush queue already serializes the callers).
 */
export function flushSceneProgress(jobId: string): Promise<void> {
  const next = (flushQueue.get(jobId) ?? Promise.resolve()).then(() =>
    _doFlush(jobId)
  );
  flushQueue.set(jobId, next);
  // Clean up the queue entry once the chain settles
  next.finally(() => {
    if (flushQueue.get(jobId) === next) flushQueue.delete(jobId);
  });
  return next;
}

async function _doFlush(jobId: string): Promise<void> {
  const progress = progressCache.get(jobId);
  if (!progress) return;

  try {
    // Use merge_job_scene_progress RPC when available (avoids read step entirely).
    // Falls back to read-modify-write — safe because the flush queue serializes callers.
    const { error: rpcErr } = await (supabase.rpc as any)(
      "merge_job_scene_progress",
      { p_job_id: jobId, p_progress: progress }
    );

    if (rpcErr) {
      // Fallback: read current payload and merge
      const { data: row } = await supabase
        .from("video_generation_jobs")
        .select("payload")
        .eq("id", jobId)
        .single();

      const existingPayload =
        row?.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : {};

      await supabase
        .from("video_generation_jobs")
        .update({
          payload: { ...existingPayload, sceneProgress: progress },
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    }

    // Broadcast real-time progress so the client gets instant updates
    // instead of waiting for the 5s polling interval.
    //
    // Implementation note: we call the Realtime REST broadcast endpoint
    // directly rather than `supabase.channel(topic).send(...)`. That older
    // pattern triggers the "Realtime send() is automatically falling back to
    // REST API" deprecation warning on every progress flush because the
    // channel isn't subscribed — `send()` silently falls back to REST and
    // logs the warning. The explicit REST call is what the library does
    // under the hood via `httpSend()`, but that method only exists in
    // supabase-js 2.50+. Worker is on 2.45.6, so we issue the same HTTPS
    // POST ourselves to avoid both the dep upgrade and the warning.
    void broadcastProgress(jobId, progress).catch(() => {
      // Non-fatal: Realtime broadcast failures must never break the job.
      // The frontend's 5s poll will catch the update on the next tick.
    });
  } catch (err) {
    console.error(`[SceneProgress] Failed to flush progress for job ${jobId}:`, (err as Error).message);
  }
}

/**
 * Clean up the in-memory progress cache for a completed job.
 */
export function clearSceneProgress(jobId: string): void {
  progressCache.delete(jobId);
}

/**
 * Get the current in-memory scene progress for a job.
 */
export function getSceneProgress(jobId: string): JobSceneProgress | undefined {
  return progressCache.get(jobId);
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildOverallMessage(progress: JobSceneProgress, failedCount: number): string {
  const { completedScenes, totalScenes, overallPhase, etaSeconds, currentSceneIndex } = progress;

  if (completedScenes === totalScenes) {
    return `${capitalize(overallPhase)} complete — all ${totalScenes} scenes processed`;
  }

  const currentScene = currentSceneIndex + 1;
  const base = `${capitalize(overallPhase)}: scene ${currentScene}/${totalScenes}`;

  const parts: string[] = [base];

  if (failedCount > 0) {
    parts.push(`(${failedCount} failed)`);
  }

  if (etaSeconds > 0) {
    const minutes = Math.floor(etaSeconds / 60);
    const seconds = etaSeconds % 60;
    const etaStr = minutes > 0 ? `~${minutes}m ${seconds}s remaining` : `~${seconds}s remaining`;
    parts.push(etaStr);
  }

  return parts.join(" — ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
