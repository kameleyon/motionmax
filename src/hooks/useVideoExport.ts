import { useState, useCallback, useEffect, useRef } from "react";
import { type ExportState } from "./export/types";
import { downloadVideo, shareVideo } from "./export/downloadHelpers";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { Scene } from "./generation/types";

export type { ExportStatus } from "./export/types";

const LOG_PREFIX = "[VideoExport:WorkerQueue]";

export function useVideoExport() {
  const [state, setState] = useState<ExportState>({ status: "idle", progress: 0 });

  // ── Guards ──
  const abortRef = useRef(false);
  const isExportingRef = useRef(false);

  // ── Per-export refs (reset each export) ──
  const activeJobIdRef = useRef<string | null>(null);
  const settledRef = useRef(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const resolveRef = useRef<((url: string) => void) | null>(null);
  const rejectRef = useRef<((e: Error) => void) | null>(null);

  const log = useCallback((...args: unknown[]) => console.log(LOG_PREFIX, ...args), []);
  const err = useCallback((...args: unknown[]) => console.error(LOG_PREFIX, ...args), []);

  // ── Interval helpers ──
  const clearPollInterval = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // ── Full cleanup (called on settled or abort) ──
  const cleanup = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    activeJobIdRef.current = null;
    if (timeoutIdRef.current) { clearTimeout(timeoutIdRef.current); timeoutIdRef.current = null; }
    clearPollInterval();
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
  }, [clearPollInterval]);

  // ── Handle a job row update from either Realtime or polling ──
  const handleJobUpdate = useCallback((updatedJob: Record<string, unknown>, source: string) => {
    if (settledRef.current) return;
    log(`[${source}] Status: ${updatedJob.status} | Progress: ${updatedJob.progress}%`);

    if (abortRef.current) {
      cleanup();
      rejectRef.current?.(new Error("Export aborted by user"));
      return;
    }

    if (updatedJob.status === "processing") {
      const progress = typeof updatedJob.progress === "number" ? updatedJob.progress : 10;
      setState({ status: "rendering", progress, warning: progress > 80 ? "Stitching video blocks natively..." : undefined });
    } else if (updatedJob.status === "completed") {
      cleanup();
      const payload = updatedJob.payload as Record<string, unknown> | null;
      const finalUrl = payload?.finalUrl as string;
      setState({ status: "complete", progress: 100, videoUrl: finalUrl });
      resolveRef.current?.(finalUrl);
    } else if (updatedJob.status === "failed") {
      cleanup();
      const errorMsg = (updatedJob.error_message as string) || "Render compilation failed";
      setState({ status: "error", progress: 0, error: errorMsg });
      rejectRef.current?.(new Error(errorMsg));
    }
  }, [log, cleanup]);

  // ── Poll the job row directly ──
  const pollJob = useCallback(async (source: string) => {
    if (settledRef.current || !activeJobIdRef.current) return;
    try {
      const { data } = await supabase
        .from("video_generation_jobs")
        .select("*")
        .eq("id", activeJobIdRef.current)
        .single();
      if (data) handleJobUpdate(data as Record<string, unknown>, source);
    } catch (e) {
      err("Poll error:", e);
    }
  }, [handleJobUpdate, err]);

  // ── Start adaptive poll interval ──
  const startPollInterval = useCallback((ms: number) => {
    clearPollInterval();
    pollIntervalRef.current = setInterval(() => { void pollJob("poll"); }, ms);
  }, [clearPollInterval, pollJob]);

  // ── Safari fix: visibilitychange recovery ──
  // When the user returns to the tab after Safari background-suspended it:
  //   • WebSocket may be CLOSED — re-subscribe Realtime
  //   • setInterval may have been throttled to 60s+ — switch back to 5s
  //   • Immediately poll so state is accurate right away
  useEffect(() => {
    const handleVisibility = () => {
      if (!activeJobIdRef.current || settledRef.current) return;
      if (document.visibilityState === "visible") {
        log("Tab visible — recovering export state after background suspension");
        void pollJob("visibility");                     // immediate poll
        startPollInterval(5000);                        // fast: 5s while visible
        // Re-subscribe Realtime if Safari closed the WebSocket
        if (channelRef.current) {
          const s = (channelRef.current as unknown as { state?: string }).state;
          if (s === "closed" || s === "timed_out") {
            log("Re-subscribing Realtime channel");
            (channelRef.current as ReturnType<typeof supabase.channel>).subscribe();
          }
        }
      } else {
        // Going to background — reduce polling to avoid Safari killing the tab
        startPollInterval(15000);                       // slow: 15s while hidden
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [log, pollJob, startPollInterval]);

  const reset = useCallback(() => {
    abortRef.current = true;
    isExportingRef.current = false;
    setState({ status: "idle", progress: 0 });
  }, []);

  const exportVideo = useCallback(
    async (
      scenes: Scene[],
      format: "landscape" | "portrait" | "square",
      brandMark?: string,
      projectId?: string
    ) => {
      if (isExportingRef.current) {
        log("Export already in progress, ignoring duplicate request");
        return;
      }
      isExportingRef.current = true;
      abortRef.current = false;
      settledRef.current = false;
      log("Starting Render Server export", { scenes: scenes.length, format });

      setState({ status: "loading", progress: 0 });

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not authenticated");

        const resolvedProjectId = projectId || crypto.randomUUID();
        log("Dropping export job into queue...");
        setState({ status: "rendering", progress: 5, warning: "Sending media to Render Node..." });

        const { data: job, error: insertError } = await supabase
          .from("video_generation_jobs")
          .insert({
            project_id: resolvedProjectId,
            user_id: user.id,
            task_type: "export_video",
            payload: { scenes, format, brandMark, project_id: resolvedProjectId } as unknown as Json,
            status: "pending",
          })
          .select()
          .single();

        if (insertError) throw insertError;
        activeJobIdRef.current = job.id;

        const result = await new Promise<string>((resolve, reject) => {
          resolveRef.current = resolve;
          rejectRef.current = reject;

          timeoutIdRef.current = setTimeout(() => {
            cleanup();
            setState({ status: "error", progress: 0, error: "Render server timed out" });
            reject(new Error("Timeout waiting for Render server"));
          }, 600000);

          // Start at the correct rate for current visibility
          startPollInterval(document.visibilityState === "visible" ? 5000 : 15000);

          channelRef.current = supabase
            .channel(`export_job_${job.id}`)
            .on(
              "postgres_changes",
              { event: "UPDATE", schema: "public", table: "video_generation_jobs", filter: `id=eq.${job.id}` },
              (payload) => handleJobUpdate(payload.new as Record<string, unknown>, "realtime")
            )
            .subscribe((status, subErr) => {
              if (status === "SUBSCRIBED") {
                log("Realtime channel subscribed — listening for worker updates.");
              } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                err(`Realtime channel issue: ${status}`, subErr);
                log("Fallback polling will continue to track job progress.");
              }
            });
        });

        isExportingRef.current = false;
        return result;
      } catch (e: unknown) {
        const msg = (e as Error).message || "Unknown export error";
        err("Export Failed", e);
        setState({ status: "error", progress: 0, error: msg });
        isExportingRef.current = false;
        throw e;
      }
    },
    [log, err, cleanup, handleJobUpdate, startPollInterval]
  );

  const handleDownload = useCallback((url: string, filename: string, userGesture = false) => {
    return downloadVideo(url, filename, userGesture);
  }, []);

  const handleShare = useCallback((url: string, filename: string) => {
    return shareVideo(url, filename);
  }, [log]);

  return { state, exportVideo, downloadVideo: handleDownload, shareVideo: handleShare, reset };
}
