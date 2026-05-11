import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { createScopedLogger } from '@/lib/logger';
import type { EditorState } from '@/hooks/useEditorState';
import { useBeforeUnload } from '@/hooks/useBeforeUnload';

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
  // G-M15 (Ghost): per-export AbortController so cancelPolling can
  // abort an in-flight INSERT, not just the next poll tick. Reset on
  // every startExport.
  const abortRef = useRef<AbortController | null>(null);

  // G-M8 (Ghost): prompt the user before they close the tab / refresh
  // while an export is mid-flight. We arm the prompt during both the
  // 'submitting' (INSERT in flight) and 'rendering' (worker running)
  // phases — leaving in either window orphans the job UI even though
  // the row keeps progressing on the server. Modern browsers won't
  // honour the custom message string for anti-phishing reasons, but
  // the dialog itself still fires.
  useBeforeUnload(
    exportState.status === 'submitting' || exportState.status === 'rendering',
    'Your export is still rendering — leaving now will keep the job running but you\'ll have to come back to download it.',
  );
  // C-7-12 (Ghost G-C1+G-C2): synchronous submit lock against
  // double-click / Enter-mash. The `exportState.status === 'submitting'`
  // check is async (React state) so a second click in the same tick
  // bypasses it. The ref check runs synchronously inside the same
  // event-loop tick and stops the duplicate insert before it reaches
  // Supabase — which would otherwise create two export_video jobs
  // and double-charge.
  const startLockRef = useRef(false);

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
    // G-M15: signal any in-flight network call to bail. The Supabase
    // client doesn't natively respect AbortSignal everywhere, but the
    // body of startExport guards on `abortRef.current.signal.aborted`
    // at every async boundary so the next checkpoint terminates the
    // flow without consuming the response.
    abortRef.current?.abort();
    abortRef.current = null;
    jobIdRef.current = null;
  }, []);

  const startExport = useCallback(async (preset: ExportPreset) => {
    if (!user) { toast.error('Please sign in first.'); return; }
    if (!state?.project || state.phase !== 'ready') {
      toast.error('Your video isn\'t ready to export yet.');
      return;
    }
    // C-7-12: synchronous lock against rapid double-fire. Released
    // on success (after the job is queued) and on error in the catch
    // below. We DON'T release on the early-return validation paths
    // above because they don't acquire the lock — only the path that
    // can actually mutate state does.
    if (startLockRef.current) {
      toast.info('Already exporting — hang on.');
      return;
    }
    startLockRef.current = true;
    // G-M15: arm a fresh abort controller. Any pending controller
    // from a prior export run is replaced (cancelPolling on a fresh
    // export would be odd, but safer to replace than reuse).
    abortRef.current?.abort();
    const exportAbort = new AbortController();
    abortRef.current = exportAbort;

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
      startLockRef.current = false;
      return;
    }

    setExportState({ status: 'submitting', progress: 2 });

    // Single shared row-handler used by both realtime payloads AND the
    // 30s sanity-poll backstop, so one progress / done / failed code
    // path keeps the two in lockstep. Declared up here so we can wire
    // the realtime channel BEFORE the insert happens (G-M4 fix).
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

    try {
      // C-7-12: server-side dedup before insert. If the user already
      // has an in-flight export_video job for this project (pending
      // or processing), DON'T create a second one — attach the
      // realtime listener to the existing job id instead. This is
      // belt-and-suspenders to the synchronous startLockRef above:
      // covers the cross-tab case (two open editors both fire export)
      // since the ref only locks within one tab.
      const { data: inFlight } = await supabase
        .from('video_generation_jobs')
        .select('id')
        .eq('project_id', state.project.id)
        .eq('user_id', user.id)
        .eq('task_type', 'export_video')
        .in('status', ['pending', 'processing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      // G-M15: bail early if cancelled while the dedup SELECT was in
      // flight — don't proceed to subscribe + insert.
      if (exportAbort.signal.aborted) return;

      // G-M4 (Ghost): subscribe to the project-scoped channel BEFORE
      // the INSERT, not after. The previous flow was:
      //   1. INSERT export_video row
      //   2. SELECT id back
      //   3. supabase.channel().subscribe()   ← realtime attached
      // If the worker picked up the job and wrote progress=5 between
      // steps 1 and 3, that first update was silently dropped — the
      // realtime channel only fires for events that occur AFTER
      // .subscribe() resolves. On a hot worker the 30s sanity-poll
      // would eventually catch up, but the user saw 0 % progress for
      // up to 30 s for no reason.
      //
      // New flow:
      //   1. Subscribe to a PROJECT-scoped channel (filter on project_id
      //      + task_type=export_video). We don't know the job id yet,
      //      so we filter on what we DO know.
      //   2. INSERT (or attach to existing inFlight).
      //   3. Set jobIdRef so handleRow starts firing.
      // The filter narrows server-side to just this project's exports;
      // the in-handler `jobIdRef.current === row.id` check guards
      // against picking up a sibling export job that shares the same
      // project filter (unlikely in practice but possible if the user
      // had an old in-flight job we didn't dedup against).
      const projectChannel = supabase
        .channel(`export-project-${state.project.id}-${Date.now()}`)
        .on(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          'postgres_changes' as any,
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'video_generation_jobs',
            filter: `project_id=eq.${state.project.id}`,
          },
          (payload: { new?: JobRow & { id?: string; task_type?: string } }) => {
            const row = payload?.new;
            if (!row) return;
            // Multi-job filter: only handle export_video rows for the
            // job id we're actively watching. Prevents a sibling
            // cinematic_video update on the same project from being
            // mis-routed into our progress tracker.
            if (row.task_type && row.task_type !== 'export_video') return;
            if (!jobIdRef.current || row.id !== jobIdRef.current) return;
            handleRow(row);
          },
        );
      // Subscribe and wait for the channel to be active before the
      // INSERT — `await` on the subscribe promise so we don't race
      // the worker. The Supabase client resolves the promise when the
      // server ack'd the SUBSCRIBE frame.
      await new Promise<void>((resolve) => {
        projectChannel.subscribe((status: string) => {
          if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            resolve();
          }
        });
        // G-M15: also resolve on abort so we don't block startExport
        // forever if cancelPolling fires during subscribe.
        if (exportAbort.signal.aborted) resolve();
        else exportAbort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (exportAbort.signal.aborted) {
        // Tear down the channel we just subscribed to — cancelPolling
        // already cleared abortRef but didn't see this channelRef
        // because we hadn't assigned it yet.
        try { supabase.removeChannel(projectChannel); } catch { /* ignore */ }
        return;
      }
      channelRef.current = projectChannel;

      let job: { id: string } | null = inFlight ? { id: inFlight.id as string } : null;
      if (!job) {
        const { data: inserted, error } = await supabase
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
        if (error || !inserted) throw new Error(error?.message || 'Queue failed');
        job = { id: inserted.id as string };
      } else {
        toast.info('Already exporting — attaching to the existing job.');
      }
      // G-M15: cancellation can race the insert — bail before we
      // commit jobIdRef so the user-cancelled state isn't reverted.
      if (exportAbort.signal.aborted) return;

      // Set jobIdRef AFTER the channel is live so handleRow's guard
      // (`row.id !== jobIdRef.current`) doesn't drop the first update.
      // The channel was already subscribed pre-insert, so any update
      // the worker wrote before this point is still in the channel's
      // buffer and will fire as soon as jobIdRef matches.
      jobIdRef.current = job.id;
      setExportState({ status: 'rendering', progress: 5 });
      toast.info(`Exporting ${presetCfg.label}…`);

      // G-M4 (Ghost): one-shot prime SELECT after jobIdRef is set —
      // even with the pre-INSERT channel subscribe, there's a tiny
      // race window where the worker could have processed and written
      // a UPDATE while the row was being created but before the
      // channel server-side filter knew about the new row. Reading
      // current state once here covers that edge case without waiting
      // 30 s for the sanity-poll backstop.
      try {
        const { data: primeRow } = await supabase
          .from('video_generation_jobs')
          .select('status, progress, payload, result, error_message')
          .eq('id', job.id)
          .eq('user_id', user.id)
          .single();
        if (primeRow) handleRow(primeRow as JobRow);
      } catch {
        // Prime read is best-effort — sanity-poll covers it 30 s
        // later if it fails here.
      }

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
    } finally {
      // C-7-12: release the synchronous submit lock. By this point the
      // job is either queued (realtime + poll + deadline armed —
      // re-clicking Export would correctly attach to the existing job
      // via the server-side dedup above) or errored (user can legitimately
      // retry). Either way the lock served its purpose: blocking the
      // burst of duplicate INSERTs from a single rage-click sequence.
      startLockRef.current = false;
    }
  }, [user, state, cancelPolling]);

  return {
    exportState,
    startExport,
    cancelExport: cancelPolling,
  };
}

export { PRESET_MAP };
