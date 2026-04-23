import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useEditorState } from '@/hooks/useEditorState';
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
  // finalize with proper dependency gates. Using it verbatim so we
  // don't re-invent what already works.
  const { startGeneration: startPipeline } = useGenerationPipeline();

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

  // Aggressive refetch while stuck on the awaiting screen. We've seen
  // React Query's cache stick on the first null result and refuse to
  // update even with staleTime: 0 + refetchIntervalInBackground: true.
  // So this effect does TWO things every 2 seconds while waiting:
  //   1. A RAW Supabase select that bypasses React Query entirely —
  //      if the generation row now exists, we know the cache is stale
  //      and we force a full invalidate.
  //   2. Calls refetchEditor() as a fallback.
  // The raw probe also logs what it finds so the browser console
  // shows exactly why the UI is stuck (row missing, RLS denied, etc).
  useEffect(() => {
    const waiting = !!state?.project && !state?.generation && !!projectId && !!user;
    if (!waiting) return;
    let cancelled = false;
    const probe = async () => {
      if (cancelled) return;
      try {
        const { data, error } = await supabase
          .from('generations')
          .select('id, status, progress, created_at')
          .eq('project_id', projectId!)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          log.warn('raw generation probe error', { error: error.message, projectId });
          return;
        }
        if (data) {
          log.info('raw probe found generation — forcing invalidate', {
            generationId: data.id,
            status: data.status,
            progress: data.progress,
          });
          // Nuke both the editor-state cache AND the active-jobs cache
          // so the UI picks up the new row + any downstream jobs. Then
          // refetch immediately so the transition is instant, not
          // waiting on the next 3s tick.
          await queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
          await queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] });
          void refetchEditor();
        }
      } catch (err) {
        log.warn('raw generation probe threw', { error: err instanceof Error ? err.message : String(err) });
      }
    };
    void probe(); // fire once immediately
    const iv = setInterval(probe, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [state?.project, state?.generation, projectId, user, refetchEditor, queryClient]);

  // Manual "Refresh" action exposed on the overlay. Full nuke + refetch.
  const forceRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['editor-state', projectId] });
    await queryClient.invalidateQueries({ queryKey: ['active-jobs', projectId] });
    await refetchEditor();
    toast.success('Refreshed');
  };
  void forceRefresh;

  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Which Inspector tab should open when the user clicks a timeline
  // clip. Undefined means "don't override — leave the user's current
  // tab alone". Timeline VOICE clips call `selectVoice` which sets
  // this to 'voice' so one click gets the user to Regenerate voice.
  const [inspectorFocusTab, setInspectorFocusTab] =
    useState<'scene' | 'voice' | 'captions' | 'motion' | undefined>(undefined);
  const saveStatus: 'idle' | 'saving' | 'saved' | 'dirty' = 'saved';

  if (isLoading) {
    return (
      <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-6 h-6 animate-spin text-[#14C8CC]" />
          <div className="font-mono text-[11px] text-[#8A9198] tracking-wider uppercase">
            Loading project…
          </div>
        </div>
      </div>
    );
  }

  if (isError || !state || !state.project) {
    return (
      <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="text-center max-w-[320px]">
          <div className="font-serif text-[22px] text-[#E66666] mb-2">Project not found</div>
          <p className="text-[13px] text-[#8A9198] mb-4">
            This project may have been deleted, or you don't have access to it.
          </p>
          <button
            type="button"
            onClick={() => navigate('/dashboard-new')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[13px] hover:bg-[#14C8CC]/20"
          >
            Back to Studio
          </button>
        </div>
      </div>
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
          <div className="font-serif text-[22px] text-[#E66666] mb-2">Couldn't start generation</div>
          <p className="text-[13px] text-[#8A9198] mb-4">
            The script job failed to queue — this is usually a credits or auth issue. Check the toast for details.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={retryStartGeneration}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] text-[13px] font-semibold hover:brightness-105"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => navigate('/dashboard-new')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[13px] hover:bg-[#14C8CC]/20"
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

  return (
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
        />
      }
      inspector={
        <Inspector
          state={state}
          selectedSceneIndex={selectedSceneIndex}
          focusTab={inspectorFocusTab}
          onTabConsumed={() => setInspectorFocusTab(undefined)}
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
        />
      }
    />
  );
}
