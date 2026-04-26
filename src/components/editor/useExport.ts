import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { createScopedLogger } from '@/lib/logger';
import type { EditorState } from '@/hooks/useEditorState';

const log = createScopedLogger('useExport');

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
  // Sanity-poll backstop: a 30s heartbeat that catches any updates the
  // realtime channel misses (network blips, stale subscriptions). The
  // primary signal is the postgres_changes channel set up below.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const deadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (deadlineTimerRef.current) clearTimeout(deadlineTimerRef.current);
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  // Rehydrate exportState from the most-recent completed export job
  // for this project. Without this, a remount of the Editor (or a
  // fresh visit to /app/editor/:id) drops the in-memory `exportState`
  // back to `idle` and the Download button silently re-runs the
  // entire export pipeline, burning credits and time. We only seed
  // when the local state is still `idle` so we never clobber an
  // in-flight export that just kicked off.
  useEffect(() => {
    const projectId = state?.project?.id;
    if (!projectId || !user?.id) return;
    let cancelled = false;
    (async () => {
      // Only seed an idle state — never overwrite an in-flight export.
      // This is checked again at write-time below in case the user
      // clicked Export between the project_id resolving and the query
      // returning.
      if (exportState.status !== 'idle') return;

      // RLS already restricts these rows to the owner, but we add
      // .eq('user_id', user.id) belt-and-braces so a leaked project_id
      // can never surface another user's exports.
      const { data: row, error } = await supabase
        .from('video_generation_jobs')
        .select('result, payload, status')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .eq('task_type', 'export_video')
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled || error || !row) return;

      // Match the URL-extraction shape used by the polling code
      // (handleRow inside startExport): prefer result.url, then
      // result.finalUrl, then payload.finalUrl/url. As the worker
      // migrates fully to result.url-only, this stays correct.
      const result = (row.result ?? {}) as { finalUrl?: string; url?: string };
      const payload = (row.payload ?? {}) as { finalUrl?: string; url?: string };
      const finalUrl = result.url ?? result.finalUrl ?? payload.finalUrl ?? payload.url;
      if (!finalUrl) return;

      setExportState((prev) =>
        prev.status === 'idle'
          ? { status: 'done', progress: 100, url: finalUrl }
          : prev,
      );
    })();
    return () => { cancelled = true; };
    // We intentionally only re-run when the project or user changes.
    // exportState.status is read inside the effect but excluded so the
    // effect doesn't re-fire every time status moves through
    // submitting → rendering → done — that would race with an
    // in-flight export. The status-check inside the body is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.project?.id, user?.id]);

  const cancelPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (deadlineTimerRef.current) {
      clearTimeout(deadlineTimerRef.current);
      deadlineTimerRef.current = null;
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    jobIdRef.current = null;
  }, []);

  const startExport = useCallback(async (preset: ExportPreset) => {
    if (!user) { toast.error('Please sign in first.'); return; }
    if (!state?.project || state.phase !== 'ready') {
      toast.error('Your video isn\'t ready to export yet.');
      return;
    }

    // Export format must FOLLOW the project's actual aspect. The old
    // "master" preset hardcoded 'landscape' which meant portrait
    // projects were exported as 16:9 (letterbox/center-crop disaster).
    // Now we override presetCfg.format with whatever the project was
    // generated in, unless the user explicitly picked a platform
    // preset (tiktok / reels / youtube) that implies its own format.
    const rawPreset = PRESET_MAP[preset];
    const projectFormat: 'landscape' | 'portrait' =
      state.project.format === 'portrait' ? 'portrait' : 'landscape';
    const presetCfg = preset === 'master'
      ? { ...rawPreset, format: projectFormat }
      : rawPreset;
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

      // Single shared row-handler used by both realtime payloads AND the
      // 30s sanity-poll backstop, so one progress / done / failed code
      // path keeps the two in lockstep.
      type JobRow = {
        status?: string;
        progress?: number;
        result?: { finalUrl?: string; url?: string } | null;
        payload?: { finalUrl?: string; url?: string } | null;
        error_message?: string | null;
      };
      const handleRow = (row: JobRow) => {
        if (!row || !jobIdRef.current) return;
        const rowProgress = typeof row.progress === 'number' ? row.progress : null;
        // Worker is migrating from `payload.finalUrl` to `result.url`.
        // Prefer `result.url` first so when the next worker iteration
        // normalises to result-only this code keeps working.
        const result = (row.result ?? {}) as { finalUrl?: string; url?: string };
        const payload = (row.payload ?? {}) as { finalUrl?: string; url?: string };
        const finalUrl = result.url ?? result.finalUrl ?? payload.finalUrl ?? payload.url;

        if (row.status === 'completed' && finalUrl) {
          cancelPolling();
          setExportState({ status: 'done', progress: 100, url: finalUrl });
          toast.success('Export ready. Download is in the topbar.');
        } else if (row.status === 'failed') {
          cancelPolling();
          const workerError = row.error_message || 'Export failed';
          log.error('Job failed', { error: workerError, jobId: jobIdRef.current, status: row.status });
          setExportState({ status: 'error', progress: 0, error: workerError });
          toast.error(`Export failed: ${workerError}`, { duration: 8000 });
        } else {
          setExportState((prev) => ({
            ...prev,
            status: 'rendering',
            progress: Math.max(prev.progress, rowProgress ?? prev.progress),
          }));
        }
      };

      // Realtime channel — primary signal. Replaces the previous 3s
      // setInterval that was producing ~500 SELECTs per export job and
      // hammering Postgres on multi-tab sessions. We listen to UPDATE
      // events on the specific job row so the channel is naturally
      // narrow.
      const ch = supabase
        .channel(`export-${job.id}`)
        .on(
          // Supabase realtime overload signature; the lib accepts the
          // string literal but TS narrows poorly here.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'postgres_changes' as any,
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'video_generation_jobs',
            filter: `id=eq.${job.id}`,
          },
          (payload: { new?: JobRow }) => {
            if (payload?.new) handleRow(payload.new);
          },
        )
        .subscribe();
      channelRef.current = ch;

      // 30s sanity-poll backstop — catches the rare case where realtime
      // misses an UPDATE (subscription not yet attached when worker
      // wrote, transient WS drop, etc.). Single SELECT per 30 s instead
      // of every 3 s — 10x reduction in DB load per export.
      pollIntervalRef.current = setInterval(async () => {
        if (!jobIdRef.current || !user?.id) return;
        // Belt-and-suspenders user_id guard — RLS already enforces this
        // but if a job id ever leaks (Sentry breadcrumb, logs, etc.)
        // explicitly scoping to the caller's user_id makes any
        // cross-user read attempt error rather than silently 404.
        const { data: row } = await supabase
          .from('video_generation_jobs')
          .select('status, progress, payload, result, error_message')
          .eq('id', jobIdRef.current)
          .eq('user_id', user.id)
          .single();
        if (row) handleRow(row as JobRow);
      }, 30_000);

      // 25-min hard deadline — same wall-clock cap as before, just
      // implemented as one timeout instead of being checked on every
      // poll tick.
      deadlineTimerRef.current = setTimeout(() => {
        if (!jobIdRef.current) return;
        cancelPolling();
        setExportState({ status: 'error', progress: 0, error: 'Export timed out' });
        toast.error('Export timed out. Try again.');
      }, 25 * 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportState({ status: 'error', progress: 0, error: msg });
      toast.error(`Couldn't queue export: ${msg}`);
    }
  }, [user, state, cancelPolling]);

  return {
    exportState,
    startExport,
    cancelExport: cancelPolling,
  };
}

export { PRESET_MAP };
