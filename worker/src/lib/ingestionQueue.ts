/**
 * ingestionQueue — pgmq-backed ingestion queue SCAFFOLD (Post-GA, FLAGGED OFF).
 *
 * Status: SCAFFOLD. Wired to NOTHING. With the flag off (the default) every
 * export here is a no-op, so the authoritative table queue
 * (public.video_generation_jobs + claim_pending_job) is completely untouched.
 *
 * WHY this exists:
 *   Ingestion enqueue/claim currently rides the same OLTP Postgres instance and
 *   connection pooler that serves all interactive traffic (see
 *   worker/src/lib/supabase.ts:91, C-8-3 / CRASH-004). That instance is a SPOF
 *   and a throughput ceiling. pgmq lets us move the ingestion enqueue/claim seam
 *   onto a durable, isolatable queue. The migration
 *   supabase/migrations/20260526000200_enable_pgmq.sql installs the substrate
 *   (extension + 'ingestion' queue). This module is the TypeScript seam that —
 *   once the 'ingestion_pgmq' flag is armed — sends jobIds into that queue and
 *   claims them back out. See docs/api/queue-isolation.md for the full design,
 *   cutover, and rollback plan.
 *
 * Contract while FLAGGED OFF (FLAG_INGESTION_PGMQ unset / false):
 *   - enqueueIngestion(...) resolves immediately, sends nothing.
 *   - claimIngestion(...)   resolves to [] (empty), claims nothing.
 *   Callers MUST treat both as advisory: the table queue remains the source of
 *   truth until cutover. The seam is intentionally additive — wiring it into the
 *   API enqueue (api/v1/videos/index.ts ~450) and the worker claim loop
 *   (worker/src/index.ts ~898-930, as a THIRD branch) is deferred and gated.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isEnabled } from "./featureFlags.js";
import { wlog } from "./workerLogger.js";

/** Feature-flag name gating all pgmq ingestion behavior. Default OFF. */
export const INGESTION_PGMQ_FLAG = "ingestion_pgmq";

/** The durable pgmq queue created by 20260526000200_enable_pgmq.sql. */
export const INGESTION_QUEUE_NAME = "ingestion";

/**
 * Shape of the message we put on the queue. We deliberately keep the payload
 * tiny — just the jobId — so the queue stays a pointer into
 * public.video_generation_jobs (the canonical row), not a second copy of job
 * state. The worker re-reads the full row after claiming.
 */
interface IngestionMessage {
  jobId: string;
}

/**
 * Enqueue a job pointer onto the pgmq 'ingestion' queue.
 *
 * NO-OP when the 'ingestion_pgmq' flag is off (the default) — resolves without
 * touching pgmq, so the table-based enqueue at api/v1/videos/index.ts remains
 * the only thing that actually queues work.
 *
 * When the flag is armed this calls pgmq.send(queue, msg). It is intended to be
 * called ALONGSIDE (not instead of) the table insert during the dual-write
 * cutover window — see docs/api/queue-isolation.md.
 *
 * Failures are logged and swallowed: while flagged-in this is a shadow path and
 * must never break the authoritative table enqueue. Throwing here is reserved
 * for the post-cutover state and is intentionally NOT done by this scaffold.
 */
export async function enqueueIngestion(
  supabase: SupabaseClient,
  jobId: string,
): Promise<void> {
  if (!(await isEnabled(INGESTION_PGMQ_FLAG, false))) {
    // Flag OFF — scaffold no-op. Table queue is authoritative.
    return;
  }

  const message: IngestionMessage = { jobId };

  // pgmq.send(queue_name text, msg jsonb) RETURNS bigint (msg_id).
  // Exposed over PostgREST as an RPC on the public schema via the pgmq wrappers
  // Supabase installs; we call it positionally to match the SQL signature.
  const { error } = await supabase.schema("pgmq").rpc("send", {
    queue_name: INGESTION_QUEUE_NAME,
    msg: message,
  });

  if (error) {
    // Shadow path: log, do NOT throw. The table enqueue is the source of truth.
    wlog.warn("ingestionQueue.enqueue failed (shadow path, ignored)", {
      jobId,
      error: error.message,
    });
    return;
  }
}

/**
 * Claim up to `qty` job pointers from the pgmq 'ingestion' queue and return
 * their jobIds. Read messages are immediately deleted (read-then-delete), so a
 * claimed message will not be re-delivered — the worker then loads the
 * authoritative row from public.video_generation_jobs and processes it exactly
 * as the table-claim path does today.
 *
 * NO-OP when the 'ingestion_pgmq' flag is off (the default) — resolves to []
 * so the worker claim loop (worker/src/index.ts ~898-930) keeps using
 * claim_pending_job() unchanged. The intended wiring is a THIRD claim branch
 * that runs only when this returns a non-empty array.
 *
 * @param qty number of messages to claim (visibility window handled by pgmq).
 */
export async function claimIngestion(
  supabase: SupabaseClient,
  qty: number,
): Promise<string[]> {
  if (!(await isEnabled(INGESTION_PGMQ_FLAG, false))) {
    // Flag OFF — scaffold no-op. claim_pending_job() remains authoritative.
    return [];
  }

  if (qty <= 0) return [];

  // pgmq.read(queue_name text, vt int, qty int) RETURNS SETOF pgmq.message_record
  // (msg_id bigint, read_ct int, enqueued_at, vt, message jsonb).
  // vt = visibility timeout (seconds) the message is hidden after read; we use a
  // short window since we delete immediately on success below.
  const VISIBILITY_TIMEOUT_SECONDS = 30;
  const { data, error } = await supabase.schema("pgmq").rpc("read", {
    queue_name: INGESTION_QUEUE_NAME,
    vt: VISIBILITY_TIMEOUT_SECONDS,
    qty,
  });

  if (error) {
    wlog.warn("ingestionQueue.claim read failed (shadow path, ignored)", {
      qty,
      error: error.message,
    });
    return [];
  }

  const rows = (data ?? []) as Array<{ msg_id: number; message: unknown }>;
  if (rows.length === 0) return [];

  const jobIds: string[] = [];
  for (const row of rows) {
    const msg = row.message as Partial<IngestionMessage> | null;
    const jobId = msg?.jobId;
    if (typeof jobId !== "string" || jobId.length === 0) {
      // Malformed message — archive it out of the way and move on.
      wlog.warn("ingestionQueue.claim skipped malformed message", {
        msgId: row.msg_id,
      });
      await archiveQuietly(supabase, row.msg_id);
      continue;
    }

    // Read-then-delete: remove the message so it is not re-delivered. If the
    // delete fails the message reappears after the visibility timeout, which is
    // the correct at-least-once fallback.
    const { error: delErr } = await supabase.schema("pgmq").rpc("delete", {
      queue_name: INGESTION_QUEUE_NAME,
      msg_id: row.msg_id,
    });
    if (delErr) {
      wlog.warn("ingestionQueue.claim delete failed; message will redeliver", {
        msgId: row.msg_id,
        error: delErr.message,
      });
      // Do NOT hand this jobId to the worker — let it redeliver to avoid
      // double-processing.
      continue;
    }

    jobIds.push(jobId);
  }

  return jobIds;
}

/**
 * Best-effort archive of a single message (moves it from q_ to a_ so it leaves
 * the active queue). Used for poison/malformed messages. Errors are swallowed.
 */
async function archiveQuietly(
  supabase: SupabaseClient,
  msgId: number,
): Promise<void> {
  const { error } = await supabase.schema("pgmq").rpc("archive", {
    queue_name: INGESTION_QUEUE_NAME,
    msg_id: msgId,
  });
  if (error) {
    wlog.warn("ingestionQueue.archive failed (ignored)", {
      msgId,
      error: error.message,
    });
  }
}
