import { useState, useCallback, useRef, useEffect } from "react";
import { type ExportState } from "./export/types";
import { downloadVideo, shareVideo } from "./export/downloadHelpers";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { Scene } from "./generation/types";

export type { ExportStatus } from "./export/types";

const LOG_PREFIX = "[VideoExport:WorkerQueue]";

/**
 * Poll interval when the tab is visible vs hidden.
 * Safari and mobile browsers throttle setInterval to 1-60s when backgrounded,
 * so we use a short visible interval and rely on visibilitychange to
 * immediately poll when the user returns to the tab.
 */
const POLL_VISIBLE_MS = 5000;
const POLL_HIDDEN_MS = 15000;

export function useVideoExport() {
  const [state, setState] = useState<ExportState>({ status: "idle", progress: 0 });
  const abortRef = useRef(false);
  // Prevents duplicate jobs when the user clicks export multiple times in quick succession
  const isExportingRef = useRef(false);
  // Track active job for visibility-change recovery
  const activeJobRef = useRef<{ jobId: string; settled: boolean } | null>(null);

  const log = useCallback((...args: any[]) => console.log(LOG_PREFIX, ...args), []);
  const err = useCallback((...args: any[]) => console.error(LOG_PREFIX, ...args), []);

  const reset = useCallback(() => {
    abortRef.current = true;
    isExportingRef.current = false;
    activeJobRef.current = null;
    setState({ status: "idle", progress: 0 });
  }, []);

  // When the tab becomes visible again, immediately poll the active job
  // This fixes Safari/mobile backgrounding issues where Realtime drops
  // and setInterval gets throttled to 60s+
  useEffect(() => {
    const onVisibilityChange = async () => {
      if (document.visibilityState !== "visible") return;
      const job = activeJobRef.current;
      if (!job || job.settled) return;

      log("Tab became visible — immediate poll for job", job.jobId);
      try {
        const { data: polledJob } = await supabase
          .from("video_generation_jobs")
          .select("*")
          .eq("id", job.jobId)
          .single();

        if (!polledJob) return;

        if (polledJob.status === "completed") {
          const finalUrl = polledJob.payload?.finalUrl;
          job.settled = true;
          setState({ status: "complete", progress: 100, videoUrl: finalUrl as string });
        } else if (polledJob.status === "failed") {
          job.settled = true;
          setState({ status: "error", progress: 0, error: polledJob.error_message || "Render compilation failed" });
        } else if (polledJob.status === "processing") {
          setState({ status: "rendering", progress: polledJob.progress || 10 });
        }
      } catch (pollErr) {
        err("Visibility poll error:", pollErr);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [log, err]);

  const exportVideo = useCallback(
    async (
      scenes: Scene[],
      format: "landscape" | "portrait" | "square",
      brandMark?: string,
      projectId?: string
    ) => {
      // Idempotency guard: drop duplicate requests while an export is already in flight
      if (isExportingRef.current) {
        log("Export already in progress, ignoring duplicate request");
        return;
      }
      isExportingRef.current = true;
      abortRef.current = false;
      log("Starting Render Server export", { scenes: scenes.length, format, brandMark: brandMark || "(none)", projectId: projectId || "(none)" });

      setState({ status: "loading", progress: 0 });

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not authenticated");

        // Use the real project ID from the generation, or generate a UUID trace
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
             status: "pending"
          })
          .select()
          .single();

        if (insertError) throw insertError;

        // Track the active job for visibility-change recovery
        const jobTracker = { jobId: job.id, settled: false };
        activeJobRef.current = jobTracker;

        const result = await new Promise<string>((resolve, reject) => {
            const timeoutMs = 600000; // 10 minute extreme timeout for massive renders

            const cleanup = (channel: ReturnType<typeof supabase.channel>, timeoutId: NodeJS.Timeout, pollId: NodeJS.Timeout) => {
                if (jobTracker.settled) return;
                jobTracker.settled = true;
                clearTimeout(timeoutId);
                clearInterval(pollId);
                supabase.removeChannel(channel);
            };

            const handleJobUpdate = (
              updatedJob: any,
              channel: ReturnType<typeof supabase.channel>,
              timeoutId: NodeJS.Timeout,
              pollId: NodeJS.Timeout,
              source: string
            ) => {
                if (jobTracker.settled) return;
                log(`[${source}] Render progress: ${updatedJob.progress}% | Status: ${updatedJob.status}`);

                if (abortRef.current) {
                    cleanup(channel, timeoutId, pollId);
                    reject(new Error("Export aborted by user"));
                    return;
                }

                if (updatedJob.status === "processing") {
                    setState({ status: "rendering", progress: updatedJob.progress || 10, warning: updatedJob.progress > 80 ? "Stitching video blocks natively..." : undefined });
                } else if (updatedJob.status === "completed") {
                    cleanup(channel, timeoutId, pollId);
                    const finalUrl = updatedJob.payload?.finalUrl;
                    setState({ status: 'complete', progress: 100, videoUrl: finalUrl });
                    resolve(finalUrl);
                } else if (updatedJob.status === "failed") {
                    cleanup(channel, timeoutId, pollId);
                    setState({ status: 'error', progress: 0, error: updatedJob.error_message || "Render compilation failed" });
                    reject(new Error(updatedJob.error_message || "Worker job failed during exporting"));
                }
            };

            // Adaptive poll interval: faster when visible, slower when hidden
            // This prevents Safari from killing the tab due to excessive background activity
            const pollFn = async () => {
                if (jobTracker.settled) return;
                try {
                    const { data: polledJob } = await supabase
                      .from("video_generation_jobs")
                      .select("*")
                      .eq("id", job.id)
                      .single();
                    if (polledJob) {
                        handleJobUpdate(polledJob, channel, timeoutId, pollId, "poll");
                    }
                } catch (pollErr) {
                    err("Fallback poll error:", pollErr);
                }
            };

            // Use a dynamic interval — poll more frequently when visible
            const getPollInterval = () => document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
            let pollId = setInterval(pollFn, getPollInterval());

            // Re-schedule polling when visibility changes to use the appropriate interval
            const adjustPollRate = () => {
                if (jobTracker.settled) return;
                clearInterval(pollId);
                pollId = setInterval(pollFn, getPollInterval());
                // If we just became visible, also do an immediate poll
                if (document.visibilityState === "visible") pollFn();
            };
            document.addEventListener("visibilitychange", adjustPollRate);

            const timeoutId = setTimeout(() => {
                document.removeEventListener("visibilitychange", adjustPollRate);
                cleanup(channel, timeoutId, pollId);
                setState({ status: "error", progress: 0, error: "Render server timed out" });
                reject(new Error("Timeout waiting for Render server"));
            }, timeoutMs);

            const channel = supabase
              .channel(`export_job_${job.id}`)
              .on(
                'postgres_changes',
                {
                  event: 'UPDATE',
                  schema: 'public',
                  table: 'video_generation_jobs',
                  filter: `id=eq.${job.id}`
                },
                (payload) => {
                  handleJobUpdate(payload.new, channel, timeoutId, pollId, "realtime");
                }
              )
              .subscribe((status, subErr) => {
                  if (status === 'SUBSCRIBED') {
                      log("Realtime channel subscribed — listening for worker updates.");
                  } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                      err(`Realtime channel issue: ${status}`, subErr);
                      log("Fallback polling will continue to track job progress.");
                  }
              });
        });

        // Clear the guard on success so the user can export again later
        isExportingRef.current = false;
        activeJobRef.current = null;
        return result;
      } catch (e: any) {
        const msg = e.message || "Unknown export error";
        err("Export Failed", e);
        setState({ status: "error", progress: 0, error: msg });
        isExportingRef.current = false;
        activeJobRef.current = null;
        throw e;
      }
    },
    [log, err]
  );

  const handleDownload = useCallback((url: string, filename: string, userGesture = false) => {
    return downloadVideo(url, filename, userGesture);
  }, []);

  const handleShare = useCallback((url: string, filename: string) => {
    return shareVideo(url, filename);
  }, [log]);

  return { state, exportVideo, downloadVideo: handleDownload, shareVideo: handleShare, reset };
}
