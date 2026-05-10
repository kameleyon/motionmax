import * as os from "os";
import { createHash } from "crypto";
import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";
import * as Sentry from "@sentry/node";

/**
 * Strip runtime-variable bits (uuids, numbers, paths) from an error
 * message so two errors that only differ by an id/timestamp collapse
 * to the same fingerprint. Mirrors public.normalize_log_message in
 * SQL — keep them in sync if either side gains rules.
 */
function normalizeLogMessage(msg: string): string {
  return (msg || "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\/[A-Za-z0-9_./-]+/g, "<path>");
}

/**
 * sha1(event_type || normalized_message) — Phase 11.3. Only computed
 * for system_error rows so the Errors tab can group identical failures
 * across users / time. Returns 12-char hex prefix (collision-safe at
 * MotionMax scale; reduces row width vs. the full 40 chars).
 */
function computeFingerprint(eventType: string, message: string): string {
  return createHash("sha1")
    .update(`${eventType}|${normalizeLogMessage(message)}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Stable per-process worker identifier. Phase 2.4 added `worker_id`
 * columns to `system_logs` and `api_call_logs` so the admin Console
 * tab can filter by replica. Resolved once at module load — Render's
 * RENDER_INSTANCE_ID, our own WORKER_ID env, or hostname fallback.
 */
const WORKER_ID: string =
  process.env.WORKER_ID ||
  process.env.RENDER_INSTANCE_ID ||
  os.hostname() ||
  "unknown-worker";

type LogCategory = "user_activity" | "system_error" | "system_warning" | "system_info";

interface LogPayload {
  userId?: string;
  projectId?: string;
  generationId?: string;
  jobId?: string;
  category: LogCategory;
  eventType: string;
  message: string;
  details?: Record<string, any>;
}

// API call logging -- matches api_call_logs table schema exactly
//
// STRICT REQUIRED FIELDS (C-8-5 / C-9-7):
//   userId         — `string | null`, NOT optional. `null` is only ever
//                    legitimate for system-level calls with no user
//                    context (e.g. the post-deploy provider key banner).
//                    Forcing the field to be present at the type level
//                    surfaces every missing-attribution callsite at
//                    compile time instead of silently writing NULL.
//   generationId   — `string | null`, NOT optional. Same rationale.
//   cost           — `number`, NOT optional. USD spend for this call.
//                    Callers MUST compute via providerRates.ts so the
//                    $/active-user, $/generated-video and abuse-
//                    forensics dashboards have real numbers to work
//                    with. `0` is reserved for genuinely free calls
//                    (e.g. health pings) — using `0` as "I don't know"
//                    breaks finops, hence the strict type.
interface ApiCallPayload {
  userId: string | null;
  generationId: string | null;
  provider: "openrouter" | "hypereal" | "elevenlabs" | "replicate" | "google_tts" | "google" | "fish_audio" | "lemonfox" | "qwen3" | "smallest";
  model: string;
  status: "success" | "error";
  queueTimeMs?: number;
  runningTimeMs?: number;
  totalDurationMs: number;
  cost: number;
  error?: string;
}

/** Maps category to a standard log level string */
function categoryToLevel(category: LogCategory): string {
  switch (category) {
    case "system_error":   return "error";
    case "system_warning": return "warn";
    default:               return "info";
  }
}

/** Emits a single JSON log line to stdout/stderr for structured parsing by log aggregators */
function emitStructuredConsoleLog(level: string, payload: LogPayload): void {
  const entry = JSON.stringify({
    ts:       new Date().toISOString(),
    level,
    category: payload.category,
    event:    payload.eventType,
    message:  payload.message,
    userId:   payload.userId,
    projectId: payload.projectId,
    generationId: payload.generationId,
    jobId:    payload.jobId,
    ...(payload.details ?? {}),
  });

  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

export async function writeSystemLog(payload: LogPayload) {
  const level = categoryToLevel(payload.category);
  emitStructuredConsoleLog(level, payload);

  // Compute a fingerprint for system_error rows so the Errors tab can
  // group identical failures. Skipped for non-error categories (would
  // be noisy + most non-error rows aren't grouped by signature).
  const fingerprint = payload.category === "system_error"
    ? computeFingerprint(payload.eventType, payload.message)
    : null;

  try {
    await supabase.from("system_logs").insert({
      id: uuidv4(),
      user_id: payload.userId || null,
      project_id: payload.projectId || null,
      generation_id: payload.generationId || null,
      category: payload.category,
      event_type: payload.eventType,
      message: payload.message,
      worker_id: WORKER_ID,
      fingerprint,
      details: {
        ...payload.details,
        worker_job_id: payload.jobId,
        worker_id: WORKER_ID,
        node_env: "render_worker"
      },
      created_at: new Date().toISOString()
    });
  } catch (dbError) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "db_log_failed", message: "Failed to write system log to database", error: String(dbError) }));
  }
}

export async function writeApiLog(payload: ApiCallPayload) {
  // Emit Sentry measurement so API durations show up as live SLO
  // (Sentry Performance → Custom Measurements dashboard)
  if (payload.totalDurationMs > 0) {
    Sentry.setMeasurement(
      `api.${payload.provider}.total_ms`,
      payload.totalDurationMs,
      "millisecond",
    );
    if (payload.status === "error") {
      Sentry.getCurrentScope().setTag("api.provider", payload.provider);
    }
  }

  // Emit a structured stderr line when a call lacks user attribution.
  // This is a soft alert — the row still lands in api_call_logs (with
  // user_id NULL) so we never lose the cost row, but the warning makes
  // it visible in log aggregators that a callsite is still using the
  // legacy untracked path. Once every callsite is migrated, this
  // warning should never fire in production.
  if (payload.userId === null || payload.generationId === null) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "api_log_missing_attribution",
      provider: payload.provider,
      model: payload.model,
      hasUserId: payload.userId !== null,
      hasGenerationId: payload.generationId !== null,
    }));
  }

  try {
    await supabase.from("api_call_logs").insert({
      id: uuidv4(),
      user_id: payload.userId,
      generation_id: payload.generationId,
      provider: payload.provider,
      model: payload.model,
      status: payload.status,
      queue_time_ms: payload.queueTimeMs || null,
      running_time_ms: payload.runningTimeMs || null,
      total_duration_ms: payload.totalDurationMs,
      cost: payload.cost,
      error_message: payload.error || null,
      worker_id: WORKER_ID,
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "api_log_failed", message: "Failed to write API log", error: String(error) }));
  }
}
