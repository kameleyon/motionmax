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
 * Failure model:
 *  - READS are fail-loud (C-7-6): if the DB errors, we throw
 *    CheckpointReadError so the caller does NOT misinterpret "DB
 *    transiently down" as "no checkpoint exists" and re-submit to
 *    Hypereal (double-spend). Genuine "no checkpoint exists" returns
 *    null (and readCheckpointKey returns undefined).
 *  - WRITES are best-effort: a failed write means the next worker
 *    re-runs the step (cheap), so we still swallow exceptions there.
 */
import { supabase } from "./supabase.js";

export type CheckpointBlob = Record<string, unknown>;

/**
 * Typed error for DB read failures while loading a checkpoint.
 *
 * The whole point of fail-loud read is so the caller can distinguish
 * "Postgres burped, retry" from "no checkpoint, start fresh". Throwing
 * a recognisable subclass lets withTransientRetry classify it via
 * isTransientError (matches /fetch failed/ or the underlying PG code
 * in `cause`).
 */
export class CheckpointReadError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CheckpointReadError";
    this.cause = cause;
  }
}

/**
 * Read the full checkpoint blob for a job.
 *
 *  - Returns `null` when the row exists but has no checkpoint (`null`
 *    column or no row at all). Callers should treat this as
 *    "no resume point, start fresh".
 *  - Throws `CheckpointReadError` on a Supabase/PG error. The caller
 *    MUST let this propagate (or explicitly retry) — silently treating
 *    a DB error as "no checkpoint" causes Hypereal/Replicate
 *    re-submission and provider-credit double-spend.
 */
export async function readCheckpoint(jobId: string): Promise<CheckpointBlob | null> {
  let response: { data: unknown; error: { message: string; code?: string } | null };
  try {
    response = await supabase
      .from("video_generation_jobs")
      .select("checkpoint")
      .eq("id", jobId)
      .maybeSingle();
  } catch (err) {
    // Network / runtime exception — the supabase client throws when the
    // transport itself fails (DNS, socket reset, etc). Surface as
    // CheckpointReadError so withTransientRetry can decide.
    throw new CheckpointReadError(
      `readCheckpoint(${jobId}) transport failure: ${(err as Error).message}`,
      err,
    );
  }
  if (response.error) {
    throw new CheckpointReadError(
      `readCheckpoint(${jobId}) DB error: ${response.error.message}`,
      response.error,
    );
  }
  const blob = (response.data as { checkpoint?: unknown } | null)?.checkpoint;
  if (blob && typeof blob === "object" && !Array.isArray(blob)) {
    return blob as CheckpointBlob;
  }
  return null;
}

/**
 * Merge `value` into the checkpoint blob under `key`. The merge is
 * shallow at the top level: existing keys other than `key` are
 * preserved, but `key`'s value is replaced wholesale (callers should
 * pass the complete record they want stored under that key).
 *
 * Writes swallow exceptions (incl. CheckpointReadError on the inner
 * read): a missed checkpoint write merely costs one re-run of the
 * step on the next worker — cheap relative to provider re-submission.
 */
export async function saveCheckpoint(
  jobId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  try {
    let current: CheckpointBlob | null = null;
    try {
      current = await readCheckpoint(jobId);
    } catch (readErr) {
      // Read failed — treat the existing blob as empty for the merge.
      // Worst case we overwrite a sibling key on next save; that's
      // acceptable vs. blowing up the handler.
      console.warn(`[checkpoint] saveCheckpoint(${jobId}, ${key}) read-before-merge failed:`, (readErr as Error).message);
    }
    const next = { ...(current ?? {}), [key]: { ...value, _ts: new Date().toISOString() } };
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

/**
 * Read a single typed sub-blob.
 *
 *  - Returns `undefined` when there's no checkpoint at all, or no
 *    matching key, or the stored value is the wrong shape.
 *  - Throws `CheckpointReadError` on a DB read failure (delegated
 *    from readCheckpoint). The caller must let it propagate —
 *    silently returning undefined here is the C-7-6 bug class
 *    (re-submits to Hypereal on a transient PG blip).
 */
export async function readCheckpointKey<T extends CheckpointBlob>(
  jobId: string,
  key: string,
): Promise<T | undefined> {
  const all = await readCheckpoint(jobId);
  if (all === null) return undefined;
  const v = all[key];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
  return undefined;
}

/** Drop a single key from the checkpoint. Used after the step it covers
 *  has been durably committed elsewhere (e.g. scene videoUrl written to
 *  generations.scenes), so the next worker doesn't waste a re-poll.
 *  Failures are swallowed — a leftover stale key just makes the next
 *  worker try to resume from a no-op poll. */
export async function clearCheckpointKey(jobId: string, key: string): Promise<void> {
  try {
    let current: CheckpointBlob | null = null;
    try {
      current = await readCheckpoint(jobId);
    } catch (readErr) {
      console.warn(`[checkpoint] clearCheckpointKey(${jobId}, ${key}) read failed:`, (readErr as Error).message);
      return;
    }
    if (current === null || !(key in current)) return;
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

/**
 * Check whether the row has a non-null checkpoint, without parsing.
 *
 * Used by the crash handler (lifecycle.ts) to decide whether to release
 * an in-flight job back to 'pending' (checkpoint exists → resumable)
 * vs. mark 'failed' (no checkpoint → starting from scratch would
 * double-spend). Returns false on DB error — fail-closed: when we
 * can't tell, we don't risk releasing for a re-claim that would
 * re-run irreversible work.
 */
export async function hasCheckpoint(jobId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("video_generation_jobs")
      .select("checkpoint")
      .eq("id", jobId)
      .maybeSingle();
    if (error) return false;
    const blob = (data as { checkpoint?: unknown } | null)?.checkpoint;
    return blob !== null && blob !== undefined;
  } catch {
    return false;
  }
}
