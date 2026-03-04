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

export async function writeSystemLog(payload: LogPayload) {
  const logPrefix = `[${payload.category.toUpperCase()}] [${payload.eventType}]`;
  if (payload.category === "system_error") {
    console.error(logPrefix, payload.message, payload.details || "");
  } else if (payload.category === "system_warning") {
    console.warn(logPrefix, payload.message, payload.details || "");
  } else {
    console.log(logPrefix, payload.message, payload.details || "");
  }

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
    console.error("CRITICAL: Failed to write system log to database:", dbError);
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
    console.error("CRITICAL: Failed to write API log:", error);
  }
}