import { useState, useCallback, useEffect, useRef } from "react";
import { type ExportState, type SceneProgressData } from "./export/types";
import { downloadVideo, shareVideo, rewriteStorageUrl } from "./export/downloadHelpers";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/databaseService";
import type { Json } from "@/integrations/supabase/types";
import type { Scene } from "./generation/types";
import { createScopedLogger } from "@/lib/logger";
import { breadcrumbExport } from "@/lib/sentryBreadcrumbs";

export type { ExportStatus } from "./export/types";

const scopedLog = createScopedLogger("VideoExport");

export function useVideoExport() {
  const [state, setState] = useState<ExportState>({ status: "idle", progress: 0 });

  // ── Guards ──
  const abortRef = useRef(false);
  const isExportingRef = useRef(false);

  // ── Per-export refs (reset each export) ──
  const activeJobIdRef = useRef<string | null>(null);
  const generationIdRef = useRef<string | null>(null);
  const settledRef = useRef(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const resolveRef = useRef<((url: string) => void) | null>(null);
  const rejectRef = useRef<((e: Error) => void) | null>(null);

  const log = useCallback((...args: unknown[]) => scopedLog.debug(args[0] as string, ...args.slice(1)), []);
  const err = useCallback((...args: unknown[]) => scopedLog.error(args[0] as string, ...args.slice(1)), []);

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
      // Extract per-scene progress from payload if available
      const payload = updatedJob.payload as Record<string, unknown> | null;
      const sceneProgress = (payload?.sceneProgress as SceneProgressData) || null;
      const overallMessage = sceneProgress?.overallMessage;
      const warning = overallMessage
        ? overallMessage
        : progress > 80
          ? "Stitching video blocks natively..."
          : undefined;
      setState({ status: "rendering", progress, warning, sceneProgress });
    } else if (updatedJob.status === "completed") {
      cleanup();
      const payload = updatedJob.payload as Record<string, unknown> | null;
      const result = updatedJob.result as Record<string, unknown> | null;
      const finalUrl = (result?.finalUrl ?? payload?.finalUrl) as string;
      setState({ status: "complete", progress: 100, videoUrl: finalUrl });
      // Persist the exported video URL to the generation so page refreshes skip re-export
      if (finalUrl && generationIdRef.current) {
        const genId = generationIdRef.current;
        db.update("generations", { video_url: finalUrl }, (q) => q.eq("id", genId))
          .then(({ error: saveErr }) => {
            if (saveErr) {
              scopedLog.error("Failed to save video_url to generation:", saveErr);
            } else {
              log("video_url persisted to generation", genId);
            }
          });
      }
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
      const { data } = await db.query("video_generation_jobs", (q) =>
        q.eq("id", activeJobIdRef.current).limit(1)
      );
      if (data?.[0]) handleJobUpdate(data[0] as Record<string, unknown>, source);
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
      projectId?: string,
      projectType?: string,
      generationId?: string,
      captionStyle?: string
    ) => {
      if (isExportingRef.current) {
        log("Export already in progress, ignoring duplicate request");
        return;
      }
      isExportingRef.current = true;
      abortRef.current = false;
      settledRef.current = false;
      breadcrumbExport({ projectId: projectId ?? "unknown", format, resolution: undefined });
      generationIdRef.current = generationId || null;
      log("Starting Render Server export", { scenes: scenes.length, format });

      setState({ status: "loading", progress: 0 });

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) throw new Error("Not authenticated");
        const user = session.user;

        const resolvedProjectId = projectId || crypto.randomUUID();
        log("Dropping export job into queue...");
        setState({ status: "rendering", progress: 5, warning: "Sending media to Render Node..." });

        const { data: jobRows, error: insertError } = await db.insert("video_generation_jobs", {
            project_id: resolvedProjectId,
            user_id: user.id,
            task_type: "export_video",
            payload: { scenes, format, brandMark, project_id: resolvedProjectId, project_type: projectType, caption_style: captionStyle || "none" } as unknown as Json,
            status: "pending",
          });

        if (insertError) {
          // Multi-tab race: the dedupe partial unique index
          // (uq_video_jobs_project_task_active) rejects a second
          // concurrent export_video insert for the same project.
          // Surface a friendly message instead of a raw "duplicate
          // key value violates unique constraint" error.
          if (/duplicate key|unique constraint|already exists/i.test(insertError)) {
            isExportingRef.current = false;
            setState({ status: "error", progress: 0, error: "An export is already running for this project — please switch to the other tab." });
            return;
          }
          throw new Error(insertError);
        }
        const job = jobRows![0];
        activeJobIdRef.current = (job as Record<string, unknown>).id as string;

        const result = await new Promise<string>((resolve, reject) => {
          resolveRef.current = resolve;
          rejectRef.current = reject;

          // Scale timeout by scene count: base 20min + 1.5min per scene beyond 12
          const baseTimeoutMs = 1_200_000; // 20 minutes
          const extraPerScene = Math.max(0, scenes.length - 12) * 90_000; // 1.5min per extra scene
          const totalTimeoutMs = baseTimeoutMs + extraPerScene;
          log(`Export timeout: ${Math.round(totalTimeoutMs / 60000)}min for ${scenes.length} scenes`);

          timeoutIdRef.current = setTimeout(() => {
            cleanup();
            setState({ status: "error", progress: 0, error: "Render server timed out" });
            reject(new Error("Timeout waiting for Render server"));
          }, totalTimeoutMs);

          // Immediate first poll + adaptive interval for current visibility
          void pollJob("initial");
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
    return downloadVideo(rewriteStorageUrl(url), filename, userGesture);
  }, []);

  const handleShare = useCallback((url: string, filename: string) => {
    return shareVideo(url, filename);
  }, [log]);

  /**
   * Load an already-exported video URL without triggering a new export.
   * Used when revisiting a project that was previously rendered.
   */
  const loadExistingVideo = useCallback((videoUrl: string) => {
    setState({ status: "complete", progress: 100, videoUrl });
  }, []);

  return { state, exportVideo, downloadVideo: handleDownload, shareVideo: handleShare, reset, loadExistingVideo };
}
