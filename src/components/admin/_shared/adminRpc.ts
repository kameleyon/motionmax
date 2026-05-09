/**
 * Phase 18.4 — admin RPC wrapper that logs latency + outcome.
 *
 * Every direct `supabase.rpc(name, args)` call in admin code can be
 * routed through `adminRpc(name, args)` instead. The wrapper:
 *
 *   1. Measures wall-clock latency.
 *   2. Inserts a row into `system_logs` with the outcome (`ok` /
 *      `error`), the RPC name, latency in ms, and the error message
 *      on failure. Insert is fire-and-forget — the caller's RPC
 *      result is not blocked by the log write.
 *   3. Adds a Sentry breadcrumb for the call so an exception inside
 *      a tab carries the call trail in the report.
 *   4. Returns the same `{ data, error }` shape as the bare client
 *      call, so it's a drop-in replacement (no API change for callers).
 *
 * Why a wrapper not a Postgres-side trigger: Postgres can't time how
 * long the JS client waited for the network round-trip, only the
 * server-side execution. Latency we care about for the admin UX is
 * end-to-end, including network. The wrapper is also the only place
 * that knows the calling tab's identity (passed via `tab`).
 *
 * Logging is best-effort: if the system_logs insert fails (RLS,
 * outage, whatever) we never throw — that would break every admin
 * RPC call. We log the meta-failure to console only.
 *
 * Note: callers that still use `supabase.rpc()` directly continue to
 * work. This wrapper is opt-in; existing tabs migrate at their own
 * pace per Phase 18.4.
 */

import * as Sentry from "@sentry/react";

import { supabase } from "@/integrations/supabase/client";

interface AdminRpcOptions {
  /** Optional tab key for the breadcrumb / log entry — defaults to "admin". */
  tab?: string;
  /** Optional category override for the system_logs row — defaults to "admin_rpc". */
  category?: string;
}

export interface AdminRpcResult<T> {
  data: T | null;
  error: { message: string } | null;
  /** Wall-clock latency in milliseconds for this call. */
  latencyMs: number;
}

export async function adminRpc<T = unknown>(
  fnName: string,
  args: Record<string, unknown> = {},
  options: AdminRpcOptions = {},
): Promise<AdminRpcResult<T>> {
  const tab = options.tab ?? "admin";
  const category = options.category ?? "admin_rpc";
  const startedAt = Date.now();

  Sentry.addBreadcrumb({
    category: "admin_rpc",
    message: `RPC: ${fnName}`,
    level: "info",
    data: { tab, fn: fnName },
  });

  // Bare RPC call. We don't pass options through — supabase-js v2
  // doesn't accept a third arg here, and adding one silently breaks.
  const { data, error } = await (supabase.rpc as unknown as (
    fn: string,
    a?: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: { message: string } | null }>)(fnName, args);

  const latencyMs = Date.now() - startedAt;

  // Fire-and-forget log write. NEVER await — a slow log insert must
  // not slow the caller's RPC return. NEVER throw — failures here are
  // operationally annoying but never user-visible.
  const logRow = {
    category,
    event_type: error ? "admin_rpc_error" : "admin_rpc_ok",
    message: `${fnName} · ${latencyMs}ms${error ? ` · ${error.message}` : ""}`,
    level: error ? "error" : "info",
    details: {
      tab,
      fn: fnName,
      latency_ms: latencyMs,
      error: error?.message ?? null,
    },
  };
  void supabase.from("system_logs").insert(logRow as never).then(({ error: logErr }) => {
    if (logErr) {
      console.warn(`[adminRpc] system_logs insert failed: ${logErr.message}`);
    }
  });

  return { data, error, latencyMs };
}
