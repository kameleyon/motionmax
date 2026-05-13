/**
 * useLipsync — drives the post-generation lipsync feature from the UI.
 *
 * Calls the `lipsync-enqueue` Edge Function to deduct credits + queue a
 * `lipsync_finalize` worker job, then subscribes to the generations
 * row via Realtime so the player can swap to the synced URL the moment
 * it lands. Falls back to a 5 s poll if Realtime is unhealthy (same
 * shape as useVideoExport).
 *
 * Usage:
 *   const { status, syncedUrl, error, start, retry } = useLipsync(generationId);
 *   <button onClick={() => start('lipsync-2')}>Sync lips to audio</button>
 *
 * The hook does NOT decide which URL the player renders — the caller
 * picks `syncedUrl ?? originalFinalUrl`. Keeping that decision in the
 * caller means a transient lipsync failure never blanks the player.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type LipsyncStatus =
  | "idle"        // no run has been started
  | "queued"      // job enqueued, worker hasn't picked it yet
  | "processing"  // worker is calling Sync Labs / polling
  | "success"     // syncedUrl is set, ready to play
  | "failed";

export interface LipsyncState {
  status: LipsyncStatus;
  syncedUrl: string | null;
  creditsCharged: number | null;
  model: "lipsync-2" | "lipsync-2-pro" | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_MS = 15 * 60 * 1000;

export function useLipsync(generationId: string | null | undefined) {
  const [state, setState] = useState<LipsyncState>({
    status: "idle",
    syncedUrl: null,
    creditsCharged: null,
    model: null,
    error: null,
  });

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef<number>(0);

  // ── Cleanup on unmount or generation change ──
  const cleanup = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // ── Read the latest row + apply to state ──
  // NB: `select("lipsync_*")` is cast via `as unknown` because the
  // Supabase generated types only learn about the lipsync_* columns
  // after `supabase gen types` is re-run post-migration. Running
  // tsc against the current generated types without the cast trips
  // SelectQueryError on every field. The runtime shape matches the
  // migration in 20260512100000_lipsync_finalize.sql.
  type LipsyncRow = {
    lipsync_status: LipsyncStatus | null;
    lipsync_video_url: string | null;
    lipsync_credits_charged: number | null;
    lipsync_model: "lipsync-2" | "lipsync-2-pro" | null;
    lipsync_error: string | null;
  };

  const refresh = useCallback(async () => {
    if (!generationId) return;
    const res = await (supabase.from("generations") as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: LipsyncRow | null; error: unknown }>;
        };
      };
    })
      .select("lipsync_status, lipsync_video_url, lipsync_credits_charged, lipsync_model, lipsync_error")
      .eq("id", generationId)
      .maybeSingle();
    if (res.error || !res.data) return;
    const data = res.data;
    const status: LipsyncStatus = data.lipsync_status ?? "idle";
    setState({
      status,
      syncedUrl: data.lipsync_video_url ?? null,
      creditsCharged: data.lipsync_credits_charged ?? null,
      model: data.lipsync_model ?? null,
      error: data.lipsync_error ?? null,
    });
    if (status === "success" || status === "failed") {
      cleanup();
    }
  }, [generationId, cleanup]);

  // ── Subscribe + initial read whenever generationId changes ──
  useEffect(() => {
    if (!generationId) return;
    void refresh();

    const channel = supabase
      .channel(`lipsync-${generationId}`)
      .on(
        "postgres_changes" as never,
        { event: "UPDATE", schema: "public", table: "generations", filter: `id=eq.${generationId}` },
        () => void refresh(),
      )
      .subscribe();
    channelRef.current = channel;

    return cleanup;
  }, [generationId, refresh, cleanup]);

  // ── Polling fallback while a run is in flight ──
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return;
    pollDeadlineRef.current = Date.now() + POLL_MAX_MS;
    pollIntervalRef.current = setInterval(() => {
      if (Date.now() > pollDeadlineRef.current) {
        cleanup();
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);
  }, [refresh, cleanup]);

  // ── Public: kick off a run ──
  const start = useCallback(
    async (model: "lipsync-2" | "lipsync-2-pro" = "lipsync-2"): Promise<void> => {
      if (!generationId) {
        setState((s) => ({ ...s, error: "No generation selected" }));
        return;
      }
      setState((s) => ({ ...s, status: "queued", error: null }));
      const { data, error } = await supabase.functions.invoke("lipsync-enqueue", {
        body: { generationId, model },
      });
      if (error || !data?.success) {
        const message =
          (data as { error?: string } | null)?.error ??
          error?.message ??
          "Failed to start lipsync";
        setState((s) => ({ ...s, status: "failed", error: message }));
        return;
      }
      startPolling();
    },
    [generationId, startPolling],
  );

  const retry = useCallback(() => start(state.model ?? "lipsync-2"), [start, state.model]);

  return { ...state, start, retry };
}
