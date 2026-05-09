/**
 * Phase 18.4 — admin-side realtime channel hook with reconnect + toast.
 *
 * Wraps `supabase.channel(name)` so each admin tab consumes realtime
 * with three guarantees the bare client doesn't provide:
 *
 *   1. **Single channel per tab.** The channel is teared down on
 *      unmount (the bare API leaks if you forget). Prevents the
 *      "channel zombies" issue where switching tabs accumulates open
 *      websockets.
 *   2. **Auto-reconnect on transient errors.** A `CHANNEL_ERROR` /
 *      `TIMED_OUT` status flips a state that the consumer can show as
 *      a stale-data hint, and the hook removes + re-subscribes after
 *      a 3s backoff. Five consecutive failures in 60s give up and
 *      surface the toast (so we don't toast-spam during a brief
 *      network blip).
 *   3. **User-visible toast** when the connection is genuinely broken
 *      (>5 errors / 60s window). One toast per outage, dismissed on
 *      next successful subscribe.
 *
 * Returns the live channel + a `connection` flag so consumers can
 * render a "connecting…" or "stale" badge.
 *
 * Usage:
 *   const { channel, connection } = useAdminRealtimeChannel(
 *     "admin-errors-feed",
 *     (ch) => {
 *       ch.on("postgres_changes", { event: "*", schema: "public", table: "...errors..." }, (p) => { ... });
 *     },
 *   );
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export type RealtimeConnection = "connecting" | "subscribed" | "stale" | "lost";

interface Options {
  /** ms between auto-reconnect attempts. Default 3000. */
  reconnectDelayMs?: number;
  /** Failures within this window count toward the toast threshold. */
  toastWindowMs?: number;
  /** Threshold of errors in `toastWindowMs` that triggers the toast. */
  toastThreshold?: number;
}

/**
 * Configure a Supabase realtime channel and own its lifecycle.
 *
 * @param channelName  Stable, per-tab channel name. Don't reuse across tabs.
 * @param configure    Synchronous setup hook called on mount + each reconnect.
 *                     Wire your `.on(...)` handlers here. The hook will call
 *                     `.subscribe()` after this returns — DO NOT subscribe
 *                     yourself.
 */
export function useAdminRealtimeChannel(
  channelName: string,
  configure: (channel: RealtimeChannel) => void,
  options: Options = {},
): { channel: RealtimeChannel | null; connection: RealtimeConnection } {
  const [connection, setConnection] = useState<RealtimeConnection>("connecting");
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Use refs so the configure callback can change without resetting state.
  const configureRef = useRef(configure);
  configureRef.current = configure;

  const reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  const toastWindowMs = options.toastWindowMs ?? 60_000;
  const toastThreshold = options.toastThreshold ?? 5;

  useEffect(() => {
    let cancelled = false;
    const errorTimestamps: number[] = [];
    let toastShown = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const subscribe = () => {
      if (cancelled) return;

      const ch = supabase.channel(channelName);
      configureRef.current(ch);
      channelRef.current = ch;

      ch.subscribe((status) => {
        if (cancelled) return;

        if (status === "SUBSCRIBED") {
          setConnection("subscribed");
          if (toastShown) {
            toast.success("Realtime reconnected");
            toastShown = false;
          }
          // Reset the error window on every clean subscribe.
          errorTimestamps.length = 0;
          return;
        }

        // CHANNEL_ERROR / TIMED_OUT / CLOSED — backoff and try again.
        const now = Date.now();
        errorTimestamps.push(now);
        // Drop stale entries outside the toast window.
        while (errorTimestamps.length > 0 && errorTimestamps[0] < now - toastWindowMs) {
          errorTimestamps.shift();
        }

        const persistent = errorTimestamps.length >= toastThreshold;
        setConnection(persistent ? "lost" : "stale");

        if (persistent && !toastShown) {
          toast.error("Connection lost — retrying", {
            description: `Realtime channel ${channelName} is unstable.`,
            id: `realtime-lost-${channelName}`,
          });
          toastShown = true;
        }

        // Tear down the failed channel before scheduling reconnect so
        // we don't pile up zombie websockets if errors happen back-to-back.
        try { supabase.removeChannel(ch); } catch { /* swallow */ }
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(subscribe, reconnectDelayMs);
      });
    };

    subscribe();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      const ch = channelRef.current;
      channelRef.current = null;
      if (ch) {
        try { supabase.removeChannel(ch); } catch { /* swallow */ }
      }
    };
    // channelName is stable for the lifetime of the consumer; configure
    // is captured via ref so changes don't blow up the channel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, reconnectDelayMs, toastWindowMs, toastThreshold]);

  return { channel: channelRef.current, connection };
}
