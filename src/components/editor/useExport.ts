import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';

export type ExportPreset = 'master' | 'youtube' | 'tiktok' | 'reels';

export interface ExportState {
  status: 'idle' | 'submitting' | 'rendering' | 'done' | 'error';
  progress: number;
  url?: string;
  error?: string;
}

const PRESET_MAP: Record<ExportPreset, { format: 'landscape' | 'portrait'; label: string; resolution: string }> = {
  master:  { format: 'landscape', label: 'Master 4K',       resolution: '4K' },
  youtube: { format: 'landscape', label: 'YouTube 4K',      resolution: '4K' },
  tiktok:  { format: 'portrait',  label: 'TikTok 1080p',    resolution: '1080p' },
  reels:   { format: 'portrait',  label: 'Reels 1080p',     resolution: '1080p' },
};

/** Reusable export submitter for the unified Editor. Submits an
 *  `export_video` job to the worker queue, polls for completion, and
 *  returns the final URL. Matches the shape already consumed by
 *  worker/src/handlers/exportVideo.ts (project_id, scenes, format,
 *  caption_style in the payload). */
export function useExport(state: EditorState | null) {
  const { user } = useAuth();
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle', progress: 0 });
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  }, []);

  const cancelPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    jobIdRef.current = null;
  }, []);

  const startExport = useCallback(async (preset: ExportPreset) => {
    if (!user) { toast.error('Please sign in first.'); return; }
    if (!state?.project || state.phase !== 'ready') {
      toast.error('Your video isn\'t ready to export yet.');
      return;
    }

    const presetCfg = PRESET_MAP[preset];
    const scenes = state.scenes
      .filter((s) => s.videoUrl || s.imageUrl)
      .map((s) => ({
        videoUrl: s.videoUrl,
        imageUrl: s.imageUrl,
        audioUrl: s.audioUrl,
        voiceover: s.voiceover,
        title: s.title,
        duration: (s.audioDurationMs ?? s.estDurationMs ?? 10_000) / 1000,
      }));

    if (scenes.length === 0) {
      toast.error('No renderable scenes yet.');
      return;
    }

    setExportState({ status: 'submitting', progress: 2 });

    try {
      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          project_id: state.project.id,
          user_id: user.id,
          task_type: 'export_video',
          // Worker reads `format`, `scenes`, `project_id`, `project_type`,
          // `caption_style` from the payload (see worker exportVideo.ts).
          payload: {
            project_id: state.project.id,
            project_type: state.project.project_type,
            format: presetCfg.format,
            scenes,
            caption_style: state.intake.captionStyle ?? 'none',
            preset,
          } as unknown as never,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error || !job) throw new Error(error?.message || 'Queue failed');

      jobIdRef.current = job.id;
      setExportState({ status: 'rendering', progress: 5 });
      toast.info(`Exporting ${presetCfg.label}…`);

      // Poll every 3s until complete / failed / timeout (25 min).
      const deadline = Date.now() + 25 * 60_000;
      pollIntervalRef.current = setInterval(async () => {
        if (!jobIdRef.current) return;
        if (Date.now() > deadline) {
          cancelPolling();
          setExportState({ status: 'error', progress: 0, error: 'Export timed out' });
          toast.error('Export timed out. Try again.');
          return;
        }
        const { data: row } = await supabase
          .from('video_generation_jobs')
          .select('status, progress, payload')
          .eq('id', jobIdRef.current)
          .single();
        if (!row) return;

        const rowProgress = typeof row.progress === 'number' ? row.progress : exportState.progress;
        const payload = (row.payload ?? {}) as { finalUrl?: string; url?: string };
        const finalUrl = payload.finalUrl ?? payload.url;

        if (row.status === 'completed' && finalUrl) {
          cancelPolling();
          setExportState({ status: 'done', progress: 100, url: finalUrl });
          toast.success('Export ready. Download is in the topbar.');
        } else if (row.status === 'failed') {
          cancelPolling();
          setExportState({ status: 'error', progress: 0, error: 'Export failed' });
          toast.error('Export failed. Please try again.');
        } else {
          setExportState((prev) => ({ ...prev, status: 'rendering', progress: Math.max(prev.progress, rowProgress) }));
        }
      }, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportState({ status: 'error', progress: 0, error: msg });
      toast.error(`Couldn't queue export: ${msg}`);
    }
  }, [user, state, cancelPolling, exportState.progress]);

  return {
    exportState,
    startExport,
    cancelExport: cancelPolling,
  };
}

export { PRESET_MAP };
