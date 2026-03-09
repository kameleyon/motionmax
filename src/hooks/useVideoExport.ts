import { useState, useCallback, useRef } from "react";
import { type ExportState } from "./export/types";
import { downloadVideo, shareVideo } from "./export/downloadHelpers";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { Scene } from "./generation/types";

export type { ExportStatus } from "./export/types";

const LOG_PREFIX = "[VideoExport:WorkerQueue]";

export function useVideoExport() {
  const [state, setState] = useState<ExportState>({ status: "idle", progress: 0 });
  const abortRef = useRef(false);

  const log = useCallback((...args: any[]) => console.log(LOG_PREFIX, ...args), []);
  const err = useCallback((...args: any[]) => console.error(LOG_PREFIX, ...args), []);

  const reset = useCallback(() => {
    abortRef.current = true;
    setState({ status: "idle", progress: 0 });
  }, []);

  const exportVideo = useCallback(
    async (
      scenes: Scene[],
      format: "landscape" | "portrait" | "square",
      brandMark?: string,
      projectId?: string
    ) => {
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

        return await new Promise<string>((resolve, reject) => {
            const timeoutMs = 600000; // 10 minute extreme timeout for massive renders
            let settled = false;

            const cleanup = (channel: ReturnType<typeof supabase.channel>, timeoutId: NodeJS.Timeout, pollId: NodeJS.Timeout) => {
                if (settled) return;
                settled = true;
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
                if (settled) return;
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

            // Fallback poll: query the job row directly every 8s in case Realtime drops events
            const pollId = setInterval(async () => {
                if (settled) return;
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
            }, 8000);

            const timeoutId = setTimeout(() => {
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
      } catch (e: any) {
        const msg = e.message || "Unknown export error";
        err("Export Failed", e);
        setState({ status: "error", progress: 0, error: msg });
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