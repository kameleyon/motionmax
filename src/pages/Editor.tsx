import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useEditorState } from '@/hooks/useEditorState';
import EditorFrame from '@/components/editor/EditorFrame';
import type { SubView } from '@/components/editor/EditorTopBar';
import Stage from '@/components/editor/Stage';
import ScenesColumn from '@/components/editor/ScenesColumn';
import Inspector from '@/components/editor/Inspector';
import Timeline from '@/components/editor/Timeline';
import { callPhase } from '@/hooks/generation/callPhase';
import { createScopedLogger } from '@/lib/logger';

const log = createScopedLogger('Editor');

/** Unified editor page: drives the rendering → ready → editing flow in
 *  one URL (/app/editor/:projectId). See player_editor_roadmap.md for
 *  the full plan. */
export default function Editor() {
  const { projectId } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const { state, isLoading, isError } = useEditorState(projectId ?? null);

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

    const payload: Record<string, unknown> = {
      phase: 'script',
      projectId: project.id,
      projectType: project.project_type,
      content: project.content,
      format: project.format,
      length: project.length,
      style: project.style,
      characterDescription: project.character_description ?? undefined,
      // Supabase generated types lag the character_images column
      // (added via migration 20260411000001). Cast through unknown
      // so the consumer gets the raw jsonb array if present.
      characterImages: Array.isArray((project as unknown as { character_images?: string[] }).character_images)
        ? (project as unknown as { character_images: string[] }).character_images
        : undefined,
      characterConsistencyEnabled: project.character_consistency_enabled ?? true,
      voiceType: 'standard',
      voiceName: project.voice_name ?? undefined,
      language: project.voice_inclination ?? 'en',
      // Intake settings live in projects.intake_settings (or its
      // _meta fallback) — every piece of context the worker's script
      // builder needs lives inside `intake`, so spread it last so it
      // takes precedence over any undefined fallbacks above.
      captionStyle: intake.captionStyle,
      brandName: intake.brandName,
      brandMark: intake.brandName,
      music: intake.music,
      lipSync: intake.lipSync,
      tone: intake.tone,
      visualStyle: intake.visualStyle,
    };

    log.info('Kicking off generate_video job', {
      projectId: project.id,
      projectType: project.project_type,
      format: project.format,
      length: project.length,
    });

    // Fire-and-forget. callPhase deducts credits upfront, queues the
    // job, and then polls until completion. We don't await — the
    // editor's realtime + polling already picks up the new generation
    // row and updates the UI. If credit deduction fails, we show a
    // toast and route the user back to the dashboard rather than
    // leaving them on a blank screen.
    void (async () => {
      try {
        setKickoffState('starting');
        await callPhase(payload, 10 * 60 * 1000);
        setKickoffState('started');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Generation kickoff failed', { error: msg });
        toast.error(`Couldn't start generation: ${msg}`, { duration: 8000 });
        setKickoffState('error');
      }
    })();
  }, [state, params, setParams]);

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

  // Kickoff-in-flight state. Project row exists, generation row does
  // NOT. We show a dedicated full-screen loader with explicit status
  // messages so the user doesn't sit on a black editor frame wondering
  // if anything is happening. Flips to the normal editor the moment
  // the worker writes the generation row (useEditorState realtime).
  if (awaitingGeneration || kickoffState === 'error') {
    const modeLabel = state.project.project_type === 'cinematic'
      ? 'Cinematic'
      : state.project.project_type === 'smartflow' ? 'Smart Flow' : 'Explainer';
    return (
      <div className="h-screen grid place-items-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="text-center max-w-[420px] px-6">
          {kickoffState === 'error' ? (
            <>
              <div className="font-serif text-[22px] text-[#E66666] mb-2">Couldn't start generation</div>
              <p className="text-[13px] text-[#8A9198] mb-4">
                The script job failed to queue — this is usually a credits or auth issue. Check the toast for details.
              </p>
              <button
                type="button"
                onClick={() => navigate('/dashboard-new')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[13px] hover:bg-[#14C8CC]/20"
              >
                Back to Studio
              </button>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center gap-5">
                <svg viewBox="0 0 50 50" width="72" height="72" aria-hidden="true">
                  <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(20,200,204,.12)" strokeWidth="3" />
                  <circle
                    cx="25" cy="25" r="20" fill="none"
                    stroke="url(#kSg)" strokeWidth="3" strokeLinecap="round" strokeDasharray="50 200"
                    transform="rotate(-90 25 25)"
                  >
                    <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1.2s" repeatCount="indefinite" />
                  </circle>
                  <defs>
                    <linearGradient id="kSg" x1="0" x2="1" y1="0" y2="1">
                      <stop offset="0%" stopColor="#14C8CC" />
                      <stop offset="100%" stopColor="#0FA6AE" />
                    </linearGradient>
                  </defs>
                </svg>
                <div className="font-serif text-[22px] font-medium text-[#ECEAE4]">
                  Starting your {modeLabel} generation…
                </div>
                <div className="font-serif italic text-[13px] text-[#8A9198]">
                  Working on your script. It may take{' '}
                  {state.project.project_type === 'cinematic'
                    ? '8–12 minutes'
                    : state.project.project_type === 'smartflow'
                      ? '60–90 seconds'
                      : '4–6 minutes'}
                  {' '}to finish everything. Feel free to leave this tab open — we'll keep working.
                </div>
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mt-2">
                  {state.project.project_type === 'cinematic'
                    ? 'Script ~30s · images ~3min · audio ~2min · video ~5min'
                    : state.project.project_type === 'smartflow'
                      ? 'Script ~20s · image ~30s · audio ~30s'
                      : 'Script ~30s · images ~2min · audio ~2min'}
                </div>
                {/* Retry affordance — if the kickoff hasn't fired in
                    the current session (idle) or we think it died,
                    offer a manual start. Critical for reload / stale
                    tab scenarios where the autostart flag has been
                    stripped but no generation row exists yet. */}
                {kickoffState === 'idle' && (
                  <button
                    type="button"
                    onClick={retryStartGeneration}
                    className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#14C8CC]/10 border border-[#14C8CC]/30 text-[#14C8CC] text-[13px] hover:bg-[#14C8CC]/20"
                  >
                    Start generation
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

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
