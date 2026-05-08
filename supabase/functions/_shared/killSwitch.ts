// Phase 17.2 — shared kill-switch / maintenance-mode gate for edge fns.
//
// Usage:
//   import { rejectIfMaintenanceOrKilled } from "../_shared/killSwitch.ts";
//   ...
//   const blocked = await rejectIfMaintenanceOrKilled(supabase, "payments", corsHeaders);
//   if (blocked) return blocked;
//
// Two flags consulted, in order:
//   1. master_kill_switch (app_settings) — always 503 except when the
//      caller is an admin (admin tools must keep working during a
//      kill-switch-engaged maintenance window).
//   2. The optional per-feature kill switch (feature_flags.<flag>) —
//      only consulted if `flagName` is passed and the caller is not
//      an admin.
//
// Admin-detection is best-effort: we read the JWT from
// `Authorization: Bearer ...` and check `is_admin(uid)`. Anonymous
// requests (no header) are treated as non-admin.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

interface MasterKillRow {
  enabled?: boolean;
  message?: string | null;
}

async function isCallerAdmin(supabase: SupabaseClient, req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.replace("Bearer ", "");
  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return false;
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    return !!roleRow;
  } catch {
    return false;
  }
}

/**
 * Returns a Response when the request should be blocked, otherwise null.
 *
 * @param supabase  service-role Supabase client
 * @param flagName  optional feature_flags row to consult (e.g. "payments").
 *                  Pass null/undefined to only check master_kill_switch.
 * @param corsHeaders headers from getCorsHeaders() so the 503 still has CORS
 * @param req       the incoming request — used to look up the caller's admin status
 */
export async function rejectIfMaintenanceOrKilled(
  supabase: SupabaseClient,
  flagName: string | null,
  corsHeaders: Record<string, string>,
  req: Request,
): Promise<Response | null> {
  // Admins are never blocked — admin tools (refunds, kill-switch
  // toggle itself, support replies) must keep working during a
  // maintenance window. Anonymous + signed-in non-admin users get
  // the 503 path below.
  const callerIsAdmin = await isCallerAdmin(supabase, req);
  if (callerIsAdmin) return null;

  // 1) master_kill_switch — global gate.
  const { data: msRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "master_kill_switch")
    .maybeSingle();
  const ms = (msRow as { value?: MasterKillRow } | null)?.value;
  if (ms?.enabled === true) {
    return new Response(
      JSON.stringify({
        error: ms.message?.trim() ||
          "MotionMax is in maintenance mode. We'll be back shortly.",
        code: "MASTER_KILL_ENGAGED",
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // 2) Optional per-feature kill switch.
  if (flagName) {
    const { data: flagRow } = await supabase
      .from("feature_flags")
      .select("enabled, description")
      .eq("flag_name", flagName)
      .maybeSingle();
    const flag = flagRow as { enabled?: boolean; description?: string } | null;
    if (flag?.enabled === true) {
      return new Response(
        JSON.stringify({
          error: flag.description?.trim() ||
            `This feature is temporarily disabled by an administrator (${flagName}).`,
          code: "KILL_SWITCH_ARMED",
          flag: flagName,
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  return null;
}
