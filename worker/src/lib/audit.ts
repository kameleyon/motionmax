/**
 * Typed audit-event wrapper around `writeSystemLog`.
 *
 * Phase 2.10 deliverable: every worker emit-point should funnel through
 * one of these helpers so the SystemEventType union stays the single
 * source of truth for analytics + the admin dashboard's Errors tab.
 *
 *   import { audit, auditError } from "../lib/audit.js";
 *   await audit("video.gen_started", { userId, generationId, message: "..." });
 *   try { ... } catch (err) { await auditError("video.gen_failed", err, { ... }); throw err; }
 *
 * `audit`      — happy-path or info / warning emits.
 * `auditError` — catch-block emits. Always sets category=system_error,
 *                fingerprints (sha1 of event_type + normalized msg) for
 *                grouping in the Errors tab, and folds err.stack into details.
 */

import { createHash } from "crypto";
import { writeSystemLog } from "./logger.js";

export type SystemEventType =
  // user activity
  | "user.signed_up"
  | "user.logged_in"
  | "user.logged_out"
  | "user.profile_updated"
  | "user.password_reset"
  | "user.account_deletion_requested"
  | "user.account_deleted"
  // generation lifecycle
  | "gen.started"
  | "gen.completed"
  | "gen.failed"
  | "gen.retried"
  | "gen.cancelled"
  // billing
  | "pay.checkout_created"
  | "pay.payment_succeeded"
  | "pay.payment_failed"
  | "pay.subscription_renewed"
  | "pay.refund_issued"
  | "pay.credits_granted"
  // worker
  | "worker.heartbeat"
  | "worker.claim_failed"
  | "worker.stale_jobs_reaped"
  // voice
  | "voice.clone_started"
  | "voice.clone_completed"
  | "voice.clone_failed"
  | "voice.tts_started"
  | "voice.tts_completed"
  | "voice.tts_failed"
  | "voice.preview_started"
  | "voice.preview_completed"
  | "voice.preview_failed"
  | "voice.deleted"
  // autopost
  | "autopost.run_started"
  | "autopost.run_completed"
  | "autopost.run_failed"
  // images / video
  | "image.gen_started"
  | "image.gen_completed"
  | "image.gen_failed"
  | "video.gen_started"
  | "video.gen_completed"
  | "video.gen_failed"
  // system
  | "system.error"
  | "system.warning";

type LogCategory = "user_activity" | "system_info" | "system_warning" | "system_error";

export interface AuditOpts {
  userId?: string | null;
  generationId?: string;
  projectId?: string;
  jobId?: string;
  message: string;
  details?: Record<string, unknown>;
  category?: LogCategory;
}

export interface AuditErrorOpts {
  userId?: string | null;
  generationId?: string;
  projectId?: string;
  jobId?: string;
  details?: Record<string, unknown>;
}

/**
 * Default category derivation from event prefix. Catches the common
 * cases so callers rarely need to override; pass `category` explicitly
 * for edge cases.
 */
function defaultCategoryFor(event: SystemEventType): LogCategory {
  if (event.endsWith("_failed") || event === "system.error") return "system_error";
  if (event === "system.warning") return "system_warning";
  if (event.startsWith("user.")) return "user_activity";
  return "system_info";
}

/**
 * Normalize an error message so the same exception thrown N times
 * fingerprints to the same hash. Strips uuids, request ids, line
 * numbers, durations, and other dynamic data that would otherwise
 * shatter grouping.
 */
function normalizeForFingerprint(msg: string): string {
  return msg
    // uuid v4-ish
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    // long hex (16+) → token sentinel
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    // standalone numbers ≥ 3 digits (durations, byte counts, ports, line nos)
    .replace(/\b\d{3,}\b/g, "<n>")
    // urls
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .trim()
    .slice(0, 500);
}

function fingerprint(event: string, message: string): string {
  const normalized = normalizeForFingerprint(message);
  return createHash("sha1").update(`${event}::${normalized}`).digest("hex");
}

/**
 * Emit a structured audit event. Wraps `writeSystemLog` with a typed
 * event_type union and category defaulting.
 */
export async function audit<E extends SystemEventType>(
  event: E,
  opts: AuditOpts,
): Promise<void> {
  const category = opts.category ?? defaultCategoryFor(event);
  await writeSystemLog({
    userId: opts.userId ?? undefined,
    projectId: opts.projectId,
    generationId: opts.generationId,
    jobId: opts.jobId,
    category,
    eventType: event,
    message: opts.message,
    details: opts.details,
  });
}

/**
 * Emit a system_error event from a catch block. Derives the message
 * from `err.message`, stores `err.stack` in details, and stamps a
 * sha1 fingerprint so the same error groups in the Errors tab.
 *
 * Caller is expected to re-throw after logging — `auditError` does
 * NOT swallow.
 */
export async function auditError(
  event: SystemEventType,
  err: unknown,
  opts: AuditErrorOpts = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const fp = fingerprint(event, message);

  const details: Record<string, unknown> = {
    ...(opts.details ?? {}),
    fingerprint: fp,
  };
  if (stack) details.stack = stack;

  await writeSystemLog({
    userId: opts.userId ?? undefined,
    projectId: opts.projectId,
    generationId: opts.generationId,
    jobId: opts.jobId,
    category: "system_error",
    eventType: event,
    message,
    details,
  });
}
