import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useEditorState } from '@/hooks/useEditorState';
import EditorFrame from '@/components/editor/EditorFrame';
import type { SubView } from '@/components/editor/EditorTopBar';
import Stage from '@/components/editor/Stage';
import ScenesColumn from '@/components/editor/ScenesColumn';
import Inspector from '@/components/editor/Inspector';
import Timeline from '@/components/editor/Timeline';

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

  // `?autostart=1` — strip after first read so refresh doesn't re-fire.
  // Actual pipeline kickoff is already handled by the Intake form today
  // (it inserts the project row and the script job); we just consume
  // the flag here and clean the URL.
  useEffect(() => {
    if (!state || !params.get('autostart')) return;
    const next = new URLSearchParams(params);
    next.delete('autostart');
    setParams(next, { replace: true });
  }, [state, params, setParams]);

  const [playing, setPlaying] = useState(false);
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
