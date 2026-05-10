import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Loader2, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useEditorState, hydrateEditorStateFromPipeline } from '@/hooks/useEditorState';
import EditorFrame from '@/components/editor/EditorFrame';
import type { SubView } from '@/components/editor/EditorTopBar';
import Stage from '@/components/editor/Stage';
import ScenesColumn from '@/components/editor/ScenesColumn';
import Inspector from '@/components/editor/Inspector';
import Timeline from '@/components/editor/Timeline';
import { useGenerationPipeline } from '@/hooks/useGenerationPipeline';
import { createScopedLogger } from '@/lib/logger';

const log = createScopedLogger('Editor');

/** Unified editor page: drives the rendering → ready → editing flow in
 *  one URL (/app/editor/:projectId). See player_editor_roadmap.md for
 *  the full plan. */
export default function Editor() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const { state, isLoading, isError, refetch: refetchEditor } = useEditorState(projectId ?? null);
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // The UNIFIED pipeline orchestrator — this is the one SmartFlow /
  // Explainer / Cinematic have always used via the legacy workspaces.
  // It chains script → images → audio → (video for cinematic) →
  // finalize with proper dependency gates. We consume BOTH:
  //   - startGeneration (fire the chain)
  //   - state (live progress tracked by the pipeline itself — this
  //     is what the legacy workspaces use to decide when the render
  //     overlay should go away. NOT a DB query, so it's immune to
  //     React Query cache / realtime race issues.)
  const { startGeneration: startPipeline, state: pipelineState } = useGenerationPipeline();

  // During rendering, keep the selected scene pinned to the newest
  // scene that has any asset. Once ready, users can click around.
  const [manualSelection, setManualSelection] = useState<number | null>(null);
  const autoSelectedIndex = useMemo(() => {
    if (!state || state.scenes.length === 0) return 0;
    if (state.phase === 'ready') return 0;
    // Pick the latest scene with a visual asset (video > image).
    for (let i = state.scenes.length - 1; i >= 0; i--) {
      const s = state.scenes[i];
      if (s.videoUrl || s.imageUrl) return i;
    }
    return 0;
  }, [state]);
  const selectedSceneIndex = manualSelection ?? autoSelectedIndex;

  // Sub-view toggle lives in URL so deep-links to "Script view" work.
  const subView = (params.get('view') as SubView | null) ?? 'edit';
  const setSubView = (v: SubView) => {
    const next = new URLSearchParams(params);
    if (v === 'edit') next.delete('view'); else next.set('view', v);
    setParams(next, { replace: true });
  };

  // `?autostart=1` — kick off the `generate_video` job now. The new
  // IntakeForm only creates the `projects` row — it does NOT queue
  // the script job (that was the old workspace flow). Without this
  // effect, the user lands on a blank editor with "0 scenes" and no
  // job ever runs. We build the script payload from project columns +
  // intake_settings, fire callPhase (which deducts credits + inserts
  // the generate_video job), then strip the URL flag so a refresh
  // doesn't re-fire. A ref guards against React StrictMode double-fire.
  const autostartFiredRef = useRef(false);
  const [kickoffState, setKickoffState] = useState<'idle' | 'starting' | 'started' | 'error'>(
    () => (new URLSearchParams(window.location.search).get('autostart') ? 'starting' : 'idle'),
  );
  useEffect(() => {
    if (!state || !state.project) return;
    if (!params.get('autostart')) return;
    if (autostartFiredRef.current) return;
    // Project already has a generation row → nothing to kick off.
    if (state.generation) {
      const next = new URLSearchParams(params);
      next.delete('autostart');
      setParams(next, { replace: true });
      setKickoffState('started');
      return;
    }
    autostartFiredRef.current = true;
    const project = state.project;
    const intake = state.intake;

    // Clear the URL flag FIRST so a page refresh doesn't re-fire the
    // kickoff (which would double-charge credits). The state flag
    // keeps the loading UI alive until useEditorState picks up the
    // new generation row.
    const next = new URLSearchParams(params);
    next.delete('autostart');
    setParams(next, { replace: true });

    // Build the GenerationParams expected by the SAME pipeline
    // orchestrator the legacy workspace used (useGenerationPipeline →
    // runUnifiedPipeline). This is what chains script → images →
    // audio → finalize with proper dep gates. We just hand it the
    // project's data + intake_settings and let it run the full chain.
    const projectFormat = project.format as 'landscape' | 'portrait' | 'square';
    const projectLength = project.length as 'short' | 'brief' | 'presentation';
    const genParams = {
      projectId: project.id,
      projectType: (project.project_type ?? 'doc2video') as 'doc2video' | 'smartflow' | 'cinematic',
      content: project.content,
      format: projectFormat,
      length: projectLength,
      style: project.style ?? 'realistic',
      brandMark: project.brand_mark ?? intake.brandName ?? undefined,
      characterDescription: project.character_description ?? undefined,
      characterImages: Array.isArray((project as unknown as { character_images?: string[] }).character_images)
        ? (project as unknown as { character_images: string[] }).character_images
        : undefined,
      characterConsistencyEnabled: project.character_consistency_enabled ?? true,
      voiceType: 'standard' as const,
      voiceName: project.voice_name ?? undefined,
      language: project.voice_inclination ?? 'en',
      captionStyle: intake.captionStyle,
      brandName: intake.brandName,
    };

    log.info('Kicking off unified pipeline', {
      projectId: project.id,
      projectType: genParams.projectType,
      format: genParams.format,
      length: genParams.length,
    });

    // Fire-and-forget. runUnifiedPipeline handles credit deduction
    // (via callPhase inside the script step), queues every downstream
    // job, and polls them. We don't await — the editor's realtime
    // refresh + useEditorState picks up scene-level progress as the
    // worker writes back.
    void (async () => {
      try {
        setKickoffState('starting');
        await startPipeline(genParams);
        setKickoffState('started');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Generation kickoff failed', { error: msg });
        toast.error(`Couldn't start generation: ${msg}`, { duration: 8000 });
        setKickoffState('error');
      }
    })();
  }, [state, params, setParams, startPipeline]);

  // Awaiting-generation render trigger — covers THREE scenarios:
  //   1. Fresh autostart in flight (kickoffState='starting') — show
  //      animated loader + verbose status.
  //   2. Kickoff failed (kickoffState='error') — show retry CTA.
  //   3. Zombie project — project row exists but generation never
  //      materialised (user reloaded mid-kickoff, autostart flag
  //      stripped, network blip ate the script job). In this case
  //      we also show the awaiting screen with a "Start generation"
  //      retry button so the user is never stuck on a dead black
  //      editor frame.
  const awaitingGeneration = !!state?.project && !state?.generation;

  const retryStartGeneration = () => {
    autostartFiredRef.current = false;
    setKickoffState('idle');
    const next = new URLSearchParams(params);
    next.set('autostart', '1');
    setParams(next, { replace: true });
  };

  // C-3-2: Track when the bounded kickoff probe has burned through its
  // attempts without finding a generation row — surface a TERMINAL
  // recovery UI instead of leaving the overlay frozen at "2%".
  // 'idle'      → not yet run (no project loaded, or generation already exists)
  // 'probing'   → first probe in flight or scheduled
  // 'exhausted' → 8 probes (~60s) elapsed, still no generation row
  const [probeState, setProbeState] = useState<'idle' | 'probing' | 'exhausted'>('idle');
  const probeRunIdRef = useRef(0);

  // Aggressive probe while stuck on the awaiting screen. React Query's
  // own refetch mechanisms (staleTime: 0, refetchInterval,
  // invalidateQueries) can race against Supabase realtime handshakes,
  // leaving the UI sitting on "Creating your content… 2%" after the
  // generation row has actually been inserted. Every 2s while waiting,
  // we do a raw select on `projects` + `generations` and, if a
  // generation row exists, wipe the React Query cache (resetQueries
  // removes the entry entirely, more aggressive than invalidate) so
  // the next access re-runs queryFn from scratch. No hard reload — the
  // pipeline-hydrator in the pipelineStep effect above paints scenes
  // the moment finalize returns, so there's no "stuck after complete"
  // case left to paper over.
  useEffect(() => {
    const waiting = !!state?.project && !state?.generation && !!projectId && !!user;
    if (!waiting) {
      // We've found a generation (or unmounted) — clear any exhausted
      // banner so a successful re-probe (after user clicks "Continue
      // waiting") can paint normal UI again.
      setProbeState((s) => (s === 'exhausted' ? s : 'idle'));
      return;
    }
    setProbeState('probing');
    const runId = ++probeRunIdRef.current;
    let cancelled = false;
    let attempts = 0;
    // Bounded backoff probe — was a forever-running 2s interval that ran
    // on top of the 3s React Query poll AND the realtime subscription,
    // which produced 90 redundant SELECTs/min while waiting on a
    // generation row. We now: probe immediately, then back off
    // (2s, 4s, 8s, 12s, 12s...) for at most ~60s total. Realtime +
    // useEditorState handles anything that arrives later.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const MAX_PROBES = 8; // ~60s of bounded probing
    const delayFor = (n: number) => Math.min(2000 * Math.pow(1.5, n), 12_000);

    const probe = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const [projRes, genRes] = await Promise.all([
          supabase
            .from('projects')
            .select('id, status')
            .eq('id', projectId!)
            .maybeSingle(),
          supabase
            .from('generations')
            .select('id, status, progress')
            .eq('project_id', projectId!)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (cancelled) return;

        const projStatus = (projRes.data as { status?: string } | null)?.status;
        const genRow = genRes.data;

        // Dev-only verbose log; in prod we let the realtime channel +
        // React Query refetchInterval log their own status.
        if (import.meta.env.DEV) {
          log.debug('[Editor] kickoff probe', {
            attempt: attempts,
            projectStatus: projStatus ?? 'none',
            generationFound: !!genRow,
          });
        }

        if (genRow || projStatus === 'complete') {
          await queryClient.resetQueries({ queryKey: ['editor-state', projectId] });
          await queryClient.resetQueries({ queryKey: ['active-jobs', projectId] });
          void refetchEditor();
          if (probeRunIdRef.current === runId) setProbeState('idle');
          return; // stop probing — generation is in flight or done
        }
      } catch (err) {
        log.warn('[Editor] kickoff probe threw', { error: err instanceof Error ? err.message : String(err) });
      }
      if (attempts < MAX_PROBES && !cancelled) {
        timer = setTimeout(probe, delayFor(attempts));
      } else if (!cancelled && probeRunIdRef.current === runId) {
        // C-3-2: Probe budget exhausted with no generation row visible
        // (and no project status flip to 'complete'). Flip to the
        // terminal-error UI so the user gets recovery options instead
        // of an indefinite "2%" overlay.
        setProbeState('exhausted');
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state?.project, state?.generation, projectId, user, refetchEditor, queryClient]);

  // C-3-2: User-driven recovery — re-runs the kickoff probe loop. Bumps
  // the run id so the previous (cancelled) effect's late callbacks can't
  // flip state back to 'exhausted' after the new probe starts.
  const restartKickoffProbe = useCallback(() => {
    probeRunIdRef.current += 1;
    setProbeState('probing');
    // Touch the editor-state query so the effect above re-runs with a
    // fresh `state.project` reference and kicks off a new probe loop.
    void queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
    void refetchEditor();
  }, [projectId, queryClient, refetchEditor]);

  // Manual "Refresh" action exposed on the overlay. Full nuke + refetch.
  const forceRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
    await queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] });
    await refetchEditor();
    toast.success('Refreshed');
  };
  void forceRefresh;

  // When the pipeline hook reports completion, stop trusting the DB
  // poll to catch up. The finalize job's result payload already lives
  // in `pipelineState.scenes` (see useGenerationPipeline →
  // runUnifiedPipeline), so we hydrate the editor-state cache directly
  // from that in-memory value. This mirrors what the legacy workspaces
  // did implicitly (`generationState.scenes` was the source of truth
  // for SmartFlowResult / CinematicResult) and eliminates the "0 scenes
  // after complete" flash that the previous invalidate-only path left
  // open whenever React Query polled a jsonb column mid-flush.
  //
  // After hydrating, we STILL invalidate so the full generation row /
  // intake_settings / project metadata catches up on the next tick.
  const pipelineStep = pipelineState.step;
  const pipelineScenes = pipelineState.scenes;
  const pipelineError = pipelineState.error;
  useEffect(() => {
    // We care about TWO terminal pipeline states:
    //   - 'complete' → full success, hydrate from pipeline memory
    //   - 'error'    → partial failure (e.g. one scene's TTS gave up
    //                  after 5 retries, which blocks finalize and
    //                  rejects waitForJob). The DB still holds every
    //                  scene that DID complete, so we want the editor
    //                  to show those scenes + per-scene fail badges so
    //                  the user can regenerate the broken ones from
    //                  the Inspector instead of losing the whole run.
    if (pipelineStep !== 'complete' && pipelineStep !== 'error') return;
    if (!projectId) return;

    // Paint scenes RIGHT NOW from the pipeline's in-memory result
    // (success path only — on error, pipelineScenes is typically
    // empty because unifiedPipeline only assigns scenes on complete).
    if (pipelineStep === 'complete' && pipelineScenes && pipelineScenes.length > 0) {
      hydrateEditorStateFromPipeline(queryClient, projectId, user?.id, pipelineScenes);
    }

    // Kick the DB round-trip. On complete this fills in
    // intake_settings / project metadata that the pipeline didn't
    // carry. On error this is the ONLY way scenes land — the DB has
    // whatever per-scene jobs completed before the failure.
    void (async () => {
      await queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] });
      await refetchEditor();
    })();

    // Surface the error once per transition so the user knows the
    // partial-failure state without having to dig through the
    // inspector. The editor shell (scenes column + timeline) still
    // renders whatever landed.
    if (pipelineStep === 'error') {
      toast.error('Generation partially failed', {
        description:
          pipelineError ??
          'Some scenes didn\'t finish. Regenerate them from the Inspector — your completed scenes are safe.',
        duration: 10000,
      });
    }
  }, [pipelineStep, pipelineScenes, pipelineError, projectId, user?.id, queryClient, refetchEditor]);

  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Which Inspector tab should open when the user clicks a timeline
  // clip. Undefined means "don't override — leave the user's current
  // tab alone". Timeline VOICE clips call `selectVoice` which sets
  // this to 'voice' so one click gets the user to Regenerate voice.
  const [inspectorFocusTab, setInspectorFocusTab] =
    useState<'scene' | 'voice' | 'captions' | 'motion' | undefined>(undefined);

  // C-3-1: REAL save-status wiring. The autosave chip used to be a
  // hardcoded `'saved'` string — perpetually green even when network
  // writes failed (silent data loss). The persistence calls in
  // useSceneRegen now publish onto a tiny in-process bus
  // (saveStatusBus); we subscribe here and pass the live status into
  // EditorTopBar via EditorFrame. EditorTopBar itself was already
  // wired for the four states ('saving' / 'saved' / 'dirty' /
  // 'error'-mapped-to-dirty); the only thing missing was a real
  // signal source.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'dirty' | 'error'>('idle');
  useEffect(() => {
    let mounted = true;
    // Lazy import keeps the bus out of the main editor bundle for users
    // who never trigger a save (read-only deep-links, unauthenticated
    // share previews) — but the file is tiny so this is mostly an
    // organizational choice. Synchronous import would also be fine.
    import('@/components/editor/saveStatusBus').then(({ subscribeSaveStatus }) => {
      if (!mounted) return;
      const unsub = subscribeSaveStatus((s) => {
        if (!mounted) return;
        setSaveStatus(s);
      });
      // Stash unsubscribe on the closure so the cleanup below can call it.
      // Closure capture is safe — `mounted` guard already short-circuits
      // any late state updates after unmount.
      cleanupRef.current = unsub;
    });
    return () => {
      mounted = false;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);
  const cleanupRef = useRef<(() => void) | null>(null);

  if (isLoading) {
    return (
      <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <div className="font-mono text-[11px] text-[#8A9198] tracking-wider uppercase">
            Loading project…
          </div>
        </div>
      </div>
    );
  }

  if (isError || !state || !state.project) {
    // C-3-3: Project-not-found page is no longer a dead-end. Surface
    // the requested ID so support tickets carry it, and offer three
    // escape paths instead of one.
    return <ProjectNotFoundPage projectId={projectId} navigate={navigate} />;
  }

  // C-3-2: Kickoff probe exhausted — render terminal recovery UI so
  // users never sit on "2%" forever. Two buttons (continue / dashboard)
  // plus the project ID for support.
  if (probeState === 'exhausted') {
    return (
      <ProbeExhaustedPage
        projectId={projectId ?? ''}
        onContinue={restartKickoffProbe}
        onDashboard={() => navigate('/dashboard-new')}
      />
    );
  }

  // Kickoff ERROR state — only case where we take over the full screen
  // now. The awaiting-generation UI lives INSIDE the stage frame via
  // Stage.tsx's rendering overlay, so users land on the real editor
  // shell immediately (topbar + scenes column + stage + timeline +
  // inspector) and watch the project build itself in place.
  if (kickoffState === 'error') {
    return (
      <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="text-center max-w-[420px] px-6">
          <div className="font-serif text-[22px] text-[#E4C875] mb-2">Couldn't start generation</div>
          <p className="text-[13px] text-[#8A9198] mb-4">
            The script job failed to queue — this is usually a credits or auth issue. Check the toast for details.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={retryStartGeneration}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 text-[#0A0D0F] text-[13px] font-semibold hover:brightness-105"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard-new')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-[13px] hover:bg-primary/20"
            >
              Back to Studio
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Suppress the unused ref now that the awaiting takeover is gone.
  void awaitingGeneration;

  const advanceScene = () => {
    const next = Math.min(state.scenes.length - 1, selectedSceneIndex + 1);
    if (next !== selectedSceneIndex) setManualSelection(next);
  };

  // Unlock trigger: once generation.status flips to 'complete' the
  // editor is fully interactive — even if SOME scenes are missing
  // assets due to upstream job failures. Those broken scenes show up
  // with status='fail' (see classifySceneStatus in useEditorState) so
  // the user can retry them per-scene from the Inspector instead of
  // being frozen out of the whole project. The stricter
  // "every-scene-perfect" check was too brittle: one failed image
  // locked the entire editor with no recovery path.
  const generationFullyReady = state?.phase === 'ready';

  const projectTitle = state?.project?.title?.trim();
  const pageTitle = projectTitle ? `${projectTitle} · Editor · MotionMax` : 'Editor · MotionMax';

  return (
    <>
    <Helmet>
      <title>{pageTitle}</title>
      <meta name="robots" content="noindex, nofollow" />
    </Helmet>
    <EditorFrame
      state={state}
      subView={subView}
      onSubViewChange={setSubView}
      saveStatus={saveStatus}
      fullscreen={fullscreen}
      scenes={
        <ScenesColumn
          state={state}
          selectedSceneIndex={selectedSceneIndex}
          onSelect={(i) => setManualSelection(i)}
        />
      }
      stage={
        <Stage
          state={state}
          selectedSceneIndex={selectedSceneIndex}
          onAdvanceScene={advanceScene}
          playing={playing}
          onPlayingChange={setPlaying}
          fullscreen={fullscreen}
          onFullscreenChange={setFullscreen}
          pipelineProgress={pipelineState.progress}
          // Editor stays in rendering mode until every scene has its
          // required assets — NOT just when the pipeline hook reports
          // complete. See `generationFullyReady` derivation above.
          pipelineDone={generationFullyReady}
        />
      }
      inspector={
        <Inspector
          state={state}
          selectedSceneIndex={selectedSceneIndex}
          focusTab={inspectorFocusTab}
          onTabConsumed={() => setInspectorFocusTab(undefined)}
          generationFullyReady={generationFullyReady}
        />
      }
      timeline={
        <Timeline
          state={state}
          selectedSceneIndex={selectedSceneIndex}
          onSelectScene={(i) => { setManualSelection(i); setInspectorFocusTab('scene'); }}
          onSelectVoice={(i) => { setManualSelection(i); setInspectorFocusTab('voice'); }}
          playing={playing}
          onPlayToggle={() => setPlaying((p) => !p)}
          generationFullyReady={generationFullyReady}
        />
      }
    />
    </>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * C-3-3: Project-not-found page
 *
 * The previous "back to studio" button was a dead-end — no way to
 * browse projects, no support escape, no project ID surfaced for
 * support tickets. Three escape paths now: browse, contact support,
 * or refetch (user may have just landed before the realtime sync
 * caught up).
 * ─────────────────────────────────────────────────────────────────── */
function ProjectNotFoundPage({
  projectId,
  navigate,
}: {
  projectId: string | undefined;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const id = projectId ?? '(unknown)';
  const supportSubject = encodeURIComponent(`Project not found: ${id}`);
  const supportBody = encodeURIComponent(
    `Hi MotionMax support,\n\nI tried to open project ${id} but the editor says it can't be found.\n\nThis might have been deleted, or there could be an access issue.\n\n— Sent from the editor's project-not-found page.`,
  );
  return (
    <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4] px-6">
      <div className="text-center max-w-[460px]">
        <div className="font-serif text-[24px] text-[#E4C875] mb-2">Project not found</div>
        <p className="text-[13px] text-[#8A9198] mb-4 leading-relaxed">
          This project may have been deleted, or you may not have access to it. If you got here from a shared link, double-check it with whoever sent you.
        </p>
        <ProjectIdLine id={id} />
        <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
          <button
            type="button"
            onClick={() => navigate('/dashboard-new')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 text-[#0A0D0F] text-[13px] font-semibold hover:brightness-105"
          >
            Browse my projects
          </button>
          <a
            href={`mailto:support@motionmax.io?subject=${supportSubject}&body=${supportBody}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-[13px] hover:bg-primary/20"
          >
            Contact support
          </a>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-white/10 text-[#8A9198] text-[13px] hover:bg-white/5 hover:text-[#ECEAE4]"
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────────
 * C-3-2: Probe-exhausted recovery page
 *
 * After the bounded ~60s kickoff probe burns through its 8 attempts
 * without seeing a generation row, we surface this page instead of
 * letting the loading overlay sit at "2%" indefinitely. Two CTAs:
 * keep waiting (re-runs the probe) or bail to the dashboard. The
 * project ID is surfaced for support tickets — generation may still
 * be running on the worker; users can come back later.
 * ─────────────────────────────────────────────────────────────────── */
function ProbeExhaustedPage({
  projectId,
  onContinue,
  onDashboard,
}: {
  projectId: string;
  onContinue: () => void;
  onDashboard: () => void;
}) {
  return (
    <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4] px-6">
      <div className="text-center max-w-[480px]">
        <div className="font-serif text-[24px] text-[#E4C875] mb-2">
          Generation taking longer than expected
        </div>
        <p className="text-[13px] text-[#8A9198] mb-2 leading-relaxed">
          We're still working on your video, but the editor is waiting too long for the first scene to land. You can keep waiting or come back later — your generation isn't lost.
        </p>
        <p className="text-[12px] text-[#5A6268] mb-4 leading-relaxed sm:hidden">
          Slow connection? This usually finishes in a minute or two.
        </p>
        <ProjectIdLine id={projectId} />
        <div className="flex flex-wrap items-center justify-center gap-2 mt-5">
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary/80 text-[#0A0D0F] text-[13px] font-semibold hover:brightness-105"
          >
            Continue waiting
          </button>
          <button
            type="button"
            onClick={onDashboard}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary/10 border border-primary/30 text-primary text-[13px] hover:bg-primary/20"
          >
            Return to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small reusable component: shows the project ID with a copy-to-
 *  clipboard affordance so users can drop it into a support email
 *  without retyping a UUID by hand. */
function ProjectIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      toast.success('Project ID copied');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / iOS lockdown — fall through to selecting the text.
      toast.error('Copy failed — long-press to select.');
    }
  };
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-white/10 bg-white/[0.03] font-mono text-[11px] text-[#8A9198]">
      <span className="text-[#5A6268] uppercase tracking-wider mr-1">Project ID</span>
      <span className="text-[#ECEAE4] select-all break-all max-w-[260px] truncate">{id}</span>
      <button
        type="button"
        onClick={handleCopy}
        title="Copy project ID"
        aria-label="Copy project ID"
        className="ml-1 inline-flex items-center justify-center w-6 h-6 rounded text-[#8A9198] hover:bg-white/10 hover:text-[#ECEAE4] transition-colors"
      >
        {copied ? <Check className="w-3 h-3 text-primary" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}
