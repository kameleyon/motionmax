/**
 * Master kill-switch (admin tab → app_settings.master_kill_switch).
 * Extracted from worker/src/index.ts on 2026-05-10 (per audit C-4-3).
 *
 * The Admin → Kill Switches UI flips a row in `app_settings` with key
 * `master_kill_switch` and value `{ enabled, message, set_by, set_at }`.
 * When enabled, the worker MUST stop claiming new generation jobs so the
 * site enters a true read-only maintenance state.
 *
 * Cached with a 10s TTL so the worker doesn't add a per-tick DB hit while
 * the switch is off — which is the steady-state. Caller is responsible
 * for log throttling on the engaged side.
 */
import { supabase } from "./supabase.js";
import { wlog } from "./workerLogger.js";

const MASTER_KILL_TTL_MS = 10_000;
let masterKillCache: { engaged: boolean; fetchedAt: number } = { engaged: false, fetchedAt: 0 };

export async function isMasterKillEngaged(): Promise<boolean> {
  const now = Date.now();
  if (now - masterKillCache.fetchedAt < MASTER_KILL_TTL_MS) {
    return masterKillCache.engaged;
  }
  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "master_kill_switch")
      .maybeSingle();
    if (error) {
      // Fail-open on read errors — never let a flaky DB lookup wedge the
      // worker. Log + use the previous cached value (defaults to false).
      wlog.warn("master_kill_switch read failed", { error: error.message });
      masterKillCache = { engaged: masterKillCache.engaged, fetchedAt: now };
      return masterKillCache.engaged;
    }
    const v = (data as { value?: { enabled?: unknown } } | null)?.value ?? null;
    const engaged = v !== null && v.enabled === true;
    masterKillCache = { engaged, fetchedAt: now };
    return engaged;
  } catch (err) {
    wlog.warn("master_kill_switch poll exception", { err: String(err) });
    masterKillCache = { engaged: masterKillCache.engaged, fetchedAt: now };
    return masterKillCache.engaged;
  }
}
