/**
 * Hero live counters for the Admin shell (Phase 1.4).
 *
 * Returns the four numbers rendered under the `Admin · control panel` h1:
 *   1,284 active now · 14 in queue · $8,612 burned this month · last deploy 4h ago
 *
 * Wiring:
 * - `activeUsers`: distinct `system_logs.user_id` where `category='user_activity'`
 *   in the last 5 min. Realtime-invalidated on `system_logs` inserts.
 * - `queueDepth`: `count(*) from video_generation_jobs where status='pending'`.
 *   Realtime-invalidated on any `video_generation_jobs` row change.
 * - `mtdSpendCents`: `sum(api_call_logs.cost)` since `date_trunc('month', now())`,
 *   converted to integer cents. Polled every 30 s — too noisy for realtime.
 * - `lastDeployAt`: `app_settings.value->>'set_at'` for `key='last_deploy_at'`.
 *   Falls back to `null` when the row isn't present yet.
 *
 * Realtime channels registered (and torn down on unmount):
 *   - `admin-live-counters:system_logs`
 *   - `admin-live-counters:video_generation_jobs`
 *
 * RLS note: Console/Activity admin RLS already gates `system_logs`,
 * `video_generation_jobs`, `api_call_logs`, and `app_settings` reads — this
 * hook never elevates privileges and assumes the caller is wrapped by
 * `<AdminRoute>` / `useAdminAuth()`.
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { adminKey, ADMIN_DEFAULT_QUERY_OPTIONS } from "./queries";

export interface AdminLiveCounters {
  activeUsers: number | null;
  queueDepth: number | null;
  mtdSpendCents: number | null;
  lastDeployAt: Date | null;
  isLoading: boolean;
}

/** 5 min window for the "active now" pill. */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** Polling interval for the MTD-spend tile. */
const SPEND_POLL_MS = 30_000;

async function fetchActiveUsers(): Promise<number> {
  const since = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("system_logs")
    .select("user_id")
    .eq("category", "user_activity")
    .gte("created_at", since)
    .not("user_id", "is", null);
  if (error) throw error;
  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.user_id) ids.add(row.user_id);
  }
  return ids.size;
}

async function fetchQueueDepth(): Promise<number> {
  const { count, error } = await supabase
    .from("video_generation_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) throw error;
  return count ?? 0;
}

async function fetchMtdSpendCents(): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("api_call_logs")
    .select("cost")
    .gte("created_at", monthStart.toISOString());
  if (error) throw error;
  let totalDollars = 0;
  for (const row of data ?? []) {
    if (typeof row.cost === "number") totalDollars += row.cost;
  }
  return Math.round(totalDollars * 100);
}

async function fetchLastDeployAt(): Promise<Date | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "last_deploy_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const raw = data.value;
  let setAt: string | undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).set_at;
    if (typeof candidate === "string") setAt = candidate;
  } else if (typeof raw === "string") {
    setAt = raw;
  }
  if (!setAt) return null;
  const parsed = new Date(setAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function useAdminLiveCounters(): AdminLiveCounters {
  const queryClient = useQueryClient();

  const activeKey = adminKey("overview", "live", "active-users");
  const queueKey = adminKey("overview", "live", "queue-depth");
  const spendKey = adminKey("overview", "live", "mtd-spend-cents");
  const deployKey = adminKey("overview", "live", "last-deploy-at");

  const activeQ = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: activeKey,
    queryFn: fetchActiveUsers,
  });

  const queueQ = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: queueKey,
    queryFn: fetchQueueDepth,
  });

  const spendQ = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: spendKey,
    queryFn: fetchMtdSpendCents,
    refetchInterval: SPEND_POLL_MS,
  });

  const deployQ = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: deployKey,
    queryFn: fetchLastDeployAt,
  });

  useEffect(() => {
    const sysLogsChannel = supabase
      .channel("admin-live-counters:system_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_logs" },
        () => {
          queryClient.invalidateQueries({ queryKey: activeKey });
        },
      )
      .subscribe();

    const jobsChannel = supabase
      .channel("admin-live-counters:video_generation_jobs")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "video_generation_jobs" },
        () => {
          queryClient.invalidateQueries({ queryKey: queueKey });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(sysLogsChannel);
      void supabase.removeChannel(jobsChannel);
    };
    // adminKey() returns a fresh array each render, so we depend on the
    // queryClient identity (stable) rather than the key arrays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  return {
    activeUsers: activeQ.data ?? null,
    queueDepth: queueQ.data ?? null,
    mtdSpendCents: spendQ.data ?? null,
    lastDeployAt: deployQ.data ?? null,
    isLoading:
      activeQ.isLoading || queueQ.isLoading || spendQ.isLoading || deployQ.isLoading,
  };
}
