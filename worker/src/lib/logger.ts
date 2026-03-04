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

export async function writeSystemLog(payload: LogPayload) {
  // Always log to standard console for raw Render debug streams
  const logPrefix = `[${payload.category.toUpperCase()}] [${payload.eventType}]`;
  if (payload.category === "system_error") {
    console.error(logPrefix, payload.message, payload.details || "");
  } else if (payload.category === "system_warning") {
    console.warn(logPrefix, payload.message, payload.details || "");
  } else {
    console.log(logPrefix, payload.message, payload.details || "");
  }

  try {
    // We insert straight into the system_logs table which the Admin UI reads
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
    // If the DB logging fails, at least the console has it
    console.error("CRITICAL: Failed to write system log to database:", dbError);
  }
}
