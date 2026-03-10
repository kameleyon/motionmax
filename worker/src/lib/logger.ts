import { supabase } from "../lib/supabase.js";
import { v4 as uuidv4 } from "uuid";

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

// New API Logging Format
interface ApiCallPayload {
  userId?: string;
  projectId?: string;
  generationId?: string;
  provider: "openrouter" | "hypereal" | "elevenlabs" | "replicate" | "google_tts";
  model: string;
  status: "success" | "error";
  durationMs: number;
  cost: number;
  requestDetails?: any;
  responseDetails?: any;
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

  try {
    await supabase.from("system_logs").insert({
      id: uuidv4(),
      user_id: payload.userId || null,
      project_id: payload.projectId || null,
      generation_id: payload.generationId || null,
      category: payload.category,
      event_type: payload.eventType,
      message: payload.message,
      details: {
        ...payload.details,
        worker_job_id: payload.jobId,
        node_env: "render_worker"
      },
      created_at: new Date().toISOString()
    });
  } catch (dbError) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "db_log_failed", message: "Failed to write system log to database", error: String(dbError) }));
  }
}

export async function writeApiLog(payload: ApiCallPayload) {
  try {
    await supabase.from("api_call_logs").insert({
      id: uuidv4(),
      user_id: payload.userId || null,
      project_id: payload.projectId || null,
      generation_id: payload.generationId || null,
      provider: payload.provider,
      model: payload.model,
      status: payload.status,
      duration_ms: payload.durationMs,
      estimated_cost: payload.cost,
      request_details: payload.requestDetails || {},
      response_details: Object.keys(payload.responseDetails || {}).length > 0 ? payload.responseDetails : undefined,
      error_message: payload.error || null,
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "api_log_failed", message: "Failed to write API log", error: String(error) }));
  }
}
