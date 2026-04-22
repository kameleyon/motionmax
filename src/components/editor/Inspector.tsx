import { useState, useEffect } from 'react';
import { RotateCw, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { EditorState } from '@/hooks/useEditorState';
import { useSceneRegen } from './useSceneRegen';

type InspectorTab = 'scene' | 'voice' | 'captions' | 'motion';

/** Per-scene inspector. V1 shows the Scene tab populated from the
 *  selected scene's fields; the other tabs are stubs that link back
 *  to the intake form for now (worker wiring for regenerate-scene
 *  lives in later phases).
 *
 *  During rendering the whole panel is disabled with an explainer —
 *  editing mid-render would race the worker's write of the final
 *  scene payload. */
export default function Inspector({
  state,
  selectedSceneIndex,
  focusTab,
  onTabConsumed,
}: {
  state: EditorState;
  selectedSceneIndex: number;
  /** External request from the Timeline to switch tabs (e.g. clicking
   *  a VOICE clip jumps the user straight to the Voice tab). */
  focusTab?: InspectorTab;
  onTabConsumed?: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('scene');

  // Parent-driven tab switch. Clears the signal so subsequent scene
  // clicks (without a tab override) don't keep snapping back.
  useEffect(() => {
    if (focusTab && focusTab !== tab) setTab(focusTab);
    if (focusTab) onTabConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTab]);
  const scene = state.scenes[selectedSceneIndex];
  const { busy, apply, regenerate, regenerateAudio } = useSceneRegen(state);

  // Local prompt buffer. Resets when the selected scene changes or
  // when the remote prompt lands.
  const [promptDraft, setPromptDraft] = useState(scene?.visualPrompt ?? '');
  useEffect(() => {
    setPromptDraft(scene?.visualPrompt ?? '');
  }, [selectedSceneIndex, scene?.visualPrompt]);

  const dirty = promptDraft.trim() !== (scene?.visualPrompt ?? '').trim();

  const disabled = state.phase === 'rendering';
  const sceneReady = state.phase !== 'rendering' && !!scene;

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-white/5">
        {(['scene', 'voice', 'captions', 'motion'] as InspectorTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            disabled={disabled}
            className={cn(
              'flex-1 py-3 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors',
              t === tab ? 'text-[#ECEAE4] border-b-2 border-[#14C8CC]' : 'text-[#5A6268] hover:text-[#ECEAE4]',
              disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Disabled state during rendering */}
      {disabled && (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center max-w-[240px]">
            <Loader2 className="w-5 h-5 animate-spin text-[#14C8CC] mx-auto mb-3" />
            <div className="font-serif text-[14px] text-[#ECEAE4] mb-1.5">
              Scenes are rendering
            </div>
            <p className="font-mono text-[10.5px] text-[#8A9198] tracking-wider leading-[1.5]">
              This panel unlocks when your video finishes rendering — about {Math.max(1, Math.round((100 - state.progress) / 10))} min remaining.
            </p>
          </div>
        </div>
      )}

      {/* Ready: Scene tab */}
      {!disabled && tab === 'scene' && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Prompt
            </h5>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={5}
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12.5px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 resize-y leading-[1.45]"
            />
            <div className="grid grid-cols-2 gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => regenerate(selectedSceneIndex, promptDraft.trim())}
                disabled={busy !== 'idle' || promptDraft.trim().length < 6}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Save the prompt and re-render this scene"
              >
                {busy === 'regen'
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <RotateCw className="w-3 h-3" />}
                Regenerate
              </button>
              <button
                type="button"
                onClick={() => apply(selectedSceneIndex, promptDraft.trim())}
                disabled={busy !== 'idle' || !dirty}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy === 'apply' ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Apply
              </button>
            </div>
          </section>

          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Narration preview
            </h5>
            <div className="bg-[#1B2228] border border-white/5 rounded-lg p-3 text-[12px] text-[#8A9198] leading-[1.55] max-h-[120px] overflow-y-auto italic">
              {scene.voiceover?.trim() || 'No narration on this scene yet.'}
            </div>
          </section>

          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Duration
            </h5>
            <div className="text-[12.5px] text-[#ECEAE4]">
              {((scene.audioDurationMs ?? scene.estDurationMs ?? 10_000) / 1000).toFixed(1)}s
              <span className="font-mono text-[10px] text-[#5A6268] tracking-[0.08em] uppercase ml-2">
                · auto from narration
              </span>
            </div>
          </section>
        </div>
      )}

      {/* Voice tab: narration preview + Regenerate button. Uses the
          worker's `regenerate_audio` task, which respects the
          project-level voice + language from intake_settings. */}
      {!disabled && tab === 'voice' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Narration text
            </h5>
            <div className="bg-[#1B2228] border border-white/5 rounded-lg p-3 text-[12.5px] text-[#ECEAE4] leading-[1.55] max-h-[160px] overflow-y-auto">
              {scene.voiceover?.trim() || <span className="text-[#5A6268] italic">No narration on this scene yet.</span>}
            </div>
          </section>

          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Voice
            </h5>
            <div className="text-[12.5px] text-[#ECEAE4]">
              {state.project?.voice_name || '—'}
              <span className="font-mono text-[10px] text-[#5A6268] tracking-[0.08em] uppercase ml-2">
                · {state.project?.voice_inclination ?? 'en'}
              </span>
            </div>
            <p className="text-[11.5px] text-[#8A9198] mt-2 leading-[1.5]">
              Voice + language come from your intake settings. Click Regenerate to re-render this scene's narration with the same voice — useful if the timing felt off or the phrasing landed weird.
            </p>
          </section>

          <button
            type="button"
            onClick={() => regenerateAudio(selectedSceneIndex)}
            disabled={busy !== 'idle' || !scene.audioUrl}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'regen'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RotateCw className="w-3 h-3" />}
            Regenerate voice
          </button>
        </div>
      )}
      {!disabled && tab === 'captions' && sceneReady && (
        <div className="flex-1 p-4 text-[12.5px] text-[#8A9198] leading-[1.6]">
          Caption style editing is coming soon. Current caption style: <span className="text-[#ECEAE4]">{state.intake.captionStyle ?? 'default'}</span>.
        </div>
      )}
      {!disabled && tab === 'motion' && sceneReady && (
        <div className="flex-1 p-4 text-[12.5px] text-[#8A9198] leading-[1.6]">
          Motion &amp; transitions (end-frame target, crossfade duration) coming soon.
        </div>
      )}

      {/* No scene selected */}
      {!disabled && !scene && (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="text-[12px] text-[#8A9198]">
            Select a scene on the left to edit its prompt, voice, or captions.
          </div>
        </div>
      )}
    </div>
  );
}
