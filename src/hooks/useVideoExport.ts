import { useState, useCallback, useRef } from "react";
import { type ExportState } from "./export/types";
import { downloadVideo, shareVideo } from "./export/downloadHelpers";
import { supabase } from "@/integrations/supabase/client";
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
             payload: { scenes, format, brandMark, project_id: resolvedProjectId },
             status: "pending"
          })
          .select()
          .single();

        if (insertError) throw insertError;

        return await new Promise<string>((resolve, reject) => {
            const timeoutMs = 600000; // 10 minute extreme timeout for massive renders
            const timeoutId = setTimeout(() => {
                supabase.removeChannel(channel);
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
                  const updatedJob = payload.new;
                  log(`Render progress: ${updatedJob.progress}% | Status: ${updatedJob.status}`);
                  
                  if (abortRef.current) {
                      clearTimeout(timeoutId);
                      supabase.removeChannel(channel);
                      reject(new Error("Export aborted by user"));
                  }

                  if (updatedJob.status === "processing") {
                      setState({ status: "rendering", progress: updatedJob.progress || 10, warning: updatedJob.progress > 80 ? "Stitching video blocks natively..." : undefined });
                  } else if (updatedJob.status === "completed") {
                      clearTimeout(timeoutId);
                      supabase.removeChannel(channel);
                      const finalUrl = updatedJob.payload.finalUrl;
                      setState({ status: 'complete', progress: 100, videoUrl: finalUrl });
                      resolve(finalUrl);
                  } else if (updatedJob.status === "failed") {
                      clearTimeout(timeoutId);
                      supabase.removeChannel(channel);
                      setState({ status: 'error', progress: 0, error: updatedJob.error_message || "Render compilation failed" });
                      reject(new Error(updatedJob.error_message || "Worker job failed during exporting"));
                  }
                }
              )
              .subscribe((status, err) => {
                  if (status === 'SUBSCRIBED') {
                      log("Listening to Render worker metrics successfully.");
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

  const handleDownload = useCallback((url: string, filename: string) => {
    return downloadVideo(url, filename);
  }, []);

  const handleShare = useCallback((url: string, filename: string) => {
    return shareVideo(url, filename);
  }, [log]);

  return { state, exportVideo, downloadVideo: handleDownload, shareVideo: handleShare, reset };
}