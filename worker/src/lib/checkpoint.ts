/**
 * Per-job resumable-handler checkpoint helpers.
 *
 * Backs the `video_generation_jobs.checkpoint` JSONB column. Handlers
 * call saveCheckpoint() at every safe resume point during long-running
 * external work (e.g. immediately after Hypereal returns a provider
 * jobId) so that if the worker is killed mid-job, the next worker that
 * claims the row can read the checkpoint and skip ahead to the next
 * step instead of re-submitting and burning external credits.
 *
 * Concurrency model: each job is single-claim (status='processing' +
 * worker_id), so there is exactly one writer per checkpoint at a time.
 * No locking required — last write wins.
 *
 * Failure model: checkpoint writes are best-effort. A failed write
 * means the next worker re-runs the step. Never throw out of these
 * helpers; the handler's primary work always takes precedence.
 */
import { supabase } from "./supabase.js";

export type CheckpointBlob = Record<string, unknown>;

/** Read the full checkpoint blob for a job. Returns {} if none exists. */
export async function readCheckpoint(jobId: string): Promise<CheckpointBlob> {
  try {
    const { data } = await supabase
      .from("video_generation_jobs")
      .select("checkpoint")
      .eq("id", jobId)
      .maybeSingle();
    const blob = (data as { checkpoint?: unknown } | null)?.checkpoint;
    if (blob && typeof blob === "object" && !Array.isArray(blob)) {
      return blob as CheckpointBlob;
    }
    return {};
  } catch (err) {
    console.warn(`[checkpoint] readCheckpoint(${jobId}) failed:`, (err as Error).message);
    return {};
  }
}

/**
 * Merge `value` into the checkpoint blob under `key`. The merge is
 * shallow at the top level: existing keys other than `key` are
 * preserved, but `key`'s value is replaced wholesale (callers should
 * pass the complete record they want stored under that key).
 */
export async function saveCheckpoint(
  jobId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  try {
    const current = await readCheckpoint(jobId);
    const next = { ...current, [key]: { ...value, _ts: new Date().toISOString() } };
    const { error } = await supabase
      .from("video_generation_jobs")
      .update({ checkpoint: next })
      .eq("id", jobId);
    if (error) {
      console.warn(`[checkpoint] saveCheckpoint(${jobId}, ${key}) failed:`, error.message);
    }
  } catch (err) {
    console.warn(`[checkpoint] saveCheckpoint(${jobId}, ${key}) exception:`, (err as Error).message);
  }
}

/** Read a single typed sub-blob. Returns undefined if missing or wrong shape. */
export async function readCheckpointKey<T extends CheckpointBlob>(
  jobId: string,
  key: string,
): Promise<T | undefined> {
  const all = await readCheckpoint(jobId);
  const v = all[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
  return undefined;
}

/** Drop a single key from the checkpoint. Used after the step it covers
 *  has been durably committed elsewhere (e.g. scene videoUrl written to
 *  generations.scenes), so the next worker doesn't waste a re-poll. */
export async function clearCheckpointKey(jobId: string, key: string): Promise<void> {
  try {
    const current = await readCheckpoint(jobId);
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    const { error } = await supabase
      .from("video_generation_jobs")
      .update({ checkpoint: Object.keys(next).length > 0 ? next : null })
      .eq("id", jobId);
    if (error) {
      console.warn(`[checkpoint] clearCheckpointKey(${jobId}, ${key}) failed:`, error.message);
    }
  } catch (err) {
    console.warn(`[checkpoint] clearCheckpointKey exception:`, (err as Error).message);
  }
}

/** Drop the entire checkpoint blob. Called by handlers on successful
 *  completion so a future re-claim of this row (e.g. user-triggered
 *  retry) starts fresh instead of resuming a stale checkpoint. */
export async function clearCheckpoint(jobId: string): Promise<void> {
  try {
    await supabase
      .from("video_generation_jobs")
      .update({ checkpoint: null })
      .eq("id", jobId);
  } catch (err) {
    console.warn(`[checkpoint] clearCheckpoint(${jobId}) exception:`, (err as Error).message);
  }
}
