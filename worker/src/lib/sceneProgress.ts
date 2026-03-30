/**
 * Per-scene progress tracking for video_generation_jobs.
 *
 * Writes structured progress data into the job's payload.sceneProgress
 * field so both the worker and frontend can track individual scene status
 * across all pipeline phases (image generation, audio generation, export).
 *
 * No database migration needed — uses existing JSONB payload column.
 */
import { supabase } from "./supabase.js";

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
 * Merges into the existing payload without overwriting other fields.
 */
export async function flushSceneProgress(jobId: string): Promise<void> {
  const progress = progressCache.get(jobId);
  if (!progress) return;

  try {
    // Read current payload to merge
    const { data: row } = await supabase
      .from("video_generation_jobs")
      .select("payload")
      .eq("id", jobId)
      .single();

    const existingPayload = (row?.payload && typeof row.payload === "object") ? row.payload as Record<string, unknown> : {};

    await supabase
      .from("video_generation_jobs")
      .update({
        payload: { ...existingPayload, sceneProgress: progress },
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
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
