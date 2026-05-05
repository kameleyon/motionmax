/**
 * Shared structured-log helper for Supabase Edge Functions.
 *
 * Phase 2.11 deliverable. Mirrors the worker's `writeSystemLog`
 * (see worker/src/lib/logger.ts) but for the Deno edge runtime.
 * Every edge function that handles a sensitive write (account
 * deletion, billing, voice cloning, admin actions) should call
 * `writeSystemLog` so the row lands in `public.system_logs` and
 * shows up on the admin Activity Feed + Errors tab.
 *
 * Caller passes its own service-role `supabase` client (so we
 * don't recreate one per call). Errors are swallowed — logging
 * must NEVER break the function it's instrumenting.
 *
 *   import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
 *   import { writeSystemLog } from "../_shared/log.ts";
 *
 *   const supabase = createClient(URL, SERVICE_ROLE);
 *   await writeSystemLog({
 *     supabase,
 *     category: "user_activity",
 *     event_type: "user.account_deletion_requested",
 *     userId,
 *     message: `Account deletion scheduled for ${userId}`,
 *     details: { scheduled_at: "..." },
 *   });
 */

// Type-only — no runtime import. Edge fns already pull this in.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

export type SystemLogCategory =
  | "user_activity"
  | "system_info"
  | "system_warning"
  | "system_error";

export interface WriteSystemLogOpts {
  supabase: SupabaseClient;
  category: SystemLogCategory;
  event_type: string;
  message: string;
  userId?: string;
  details?: Record<string, unknown>;
  generationId?: string;
  projectId?: string;
}

/**
 * Best-effort insert into `public.system_logs`. Always resolves —
 * logging failures are surfaced via console.error and never thrown,
 * so a misconfigured DB cannot break a billing webhook or an
 * account deletion.
 */
export async function writeSystemLog(opts: WriteSystemLogOpts): Promise<void> {
  const {
    supabase,
    category,
    event_type,
    message,
    userId,
    details,
    generationId,
    projectId,
  } = opts;

  // Mirror worker structured-stdout line so log drains see the same
  // shape from edge fns and the worker.
  const stdoutEntry = JSON.stringify({
    ts: new Date().toISOString(),
    level:
      category === "system_error"
        ? "error"
        : category === "system_warning"
          ? "warn"
          : "info",
    source: "edge",
    category,
    event: event_type,
    message,
    userId,
    projectId,
    generationId,
    ...(details ?? {}),
  });
  if (category === "system_error") console.error(stdoutEntry);
  else if (category === "system_warning") console.warn(stdoutEntry);
  else console.log(stdoutEntry);

  try {
    const { error } = await supabase.from("system_logs").insert({
      user_id: userId ?? null,
      project_id: projectId ?? null,
      generation_id: generationId ?? null,
      category,
      event_type,
      message,
      details: {
        ...(details ?? {}),
        source: "edge_function",
      },
      created_at: new Date().toISOString(),
    });
    if (error) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event: "edge_log_insert_failed",
          message: "system_logs insert failed",
          error: error.message,
          event_type,
        }),
      );
    }
  } catch (err) {
    // Logging must never break the calling function. Swallow.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "edge_log_insert_threw",
        message: "writeSystemLog threw",
        error: err instanceof Error ? err.message : String(err),
        event_type,
      }),
    );
  }
}
