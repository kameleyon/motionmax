import { useState, useEffect } from 'react';
import { RotateCw, Loader2, Video, Image as ImageIcon, Wand2, Lock, UserPlus, AudioLines, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  getSpeakersForLanguage,
  getSampleText,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';
import { captionStyles, type CaptionStyle } from '@/components/workspace/CaptionStyleSelector';
import type { EditorState } from '@/hooks/useEditorState';
import { useSceneRegen } from './useSceneRegen';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

type InspectorTab = 'scene' | 'voice' | 'captions' | 'motion';

type Motion = 'Still' | 'Push-in' | 'Pan' | 'Dolly';
type Transition = 'Cut' | 'Dissolve' | 'Whip' | 'Black';
const MOTION_OPTIONS: Motion[] = ['Still', 'Push-in', 'Pan', 'Dolly'];
const TRANSITION_OPTIONS: Transition[] = ['Cut', 'Dissolve', 'Whip', 'Black'];

function prettyVoiceName(raw: string | null | undefined): string {
  if (!raw) return '—';
  const stripped = raw.replace(/^(sm2?|gm):/i, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export default function Inspector({
  state,
  selectedSceneIndex,
  focusTab,
  onTabConsumed,
}: {
  state: EditorState;
  selectedSceneIndex: number;
  focusTab?: InspectorTab;
  onTabConsumed?: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('scene');
  const { user } = useAuth();

  useEffect(() => {
    if (focusTab && focusTab !== tab) setTab(focusTab);
    if (focusTab) onTabConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTab]);

  const scene = state.scenes[selectedSceneIndex];
  const {
    busy, apply, regenerate, regenerateImage, regenerateVideo, regenerateAudio,
    updateSceneMeta, updateProjectVoice, updateIntakeSettings,
  } = useSceneRegen(state);

  const [promptDraft, setPromptDraft] = useState(scene?.visualPrompt ?? '');
  useEffect(() => {
    setPromptDraft(scene?.visualPrompt ?? '');
  }, [selectedSceneIndex, scene?.visualPrompt]);
  const dirty = promptDraft.trim() !== (scene?.visualPrompt ?? '').trim();

  // Editable narration buffer — Voice tab mirrors the legacy
  // CinematicEditModal pattern: show the text, let user edit, play the
  // CURRENT audioUrl, fire Save & Regenerate when the text changed.
  const [voiceoverDraft, setVoiceoverDraft] = useState(scene?.voiceover ?? '');
  useEffect(() => {
    setVoiceoverDraft(scene?.voiceover ?? '');
  }, [selectedSceneIndex, scene?.voiceover]);
  const voiceoverDirty = voiceoverDraft.trim() !== (scene?.voiceover ?? '').trim();

  const meta = scene?.meta ?? {};
  const motion = (meta.motion as Motion | undefined) ?? 'Push-in';
  const transition = (meta.transition as Transition | undefined) ?? 'Cut';

  // Captions are a PROJECT-level setting (apply to the entire video),
  // stored in intake_settings. captionStyle === 'none' means off.
  // Local draft state keeps the toggle / dropdown instantly responsive
  // — we flush to Supabase asynchronously, so the UI doesn't wait on
  // the round-trip.
  const savedCaptionStyle = (state.intake.captionStyle as CaptionStyle | undefined) ?? 'cleanPop';
  const [captionStyleDraft, setCaptionStyleDraft] = useState<CaptionStyle>(savedCaptionStyle);
  useEffect(() => { setCaptionStyleDraft(savedCaptionStyle); }, [savedCaptionStyle]);
  const captionsOn = captionStyleDraft !== 'none';

  const toggleCaptions = () => {
    // Off → on: flip to cleanPop (the default shipped style).
    // On → off: store 'none' so the export knows to skip burn-in.
    const next: CaptionStyle = captionsOn ? 'none' : (savedCaptionStyle === 'none' ? 'cleanPop' : savedCaptionStyle);
    setCaptionStyleDraft(next);
    void updateIntakeSettings({ captionStyle: next });
  };

  const setCaptionStyle = (s: CaptionStyle) => {
    setCaptionStyleDraft(s);
    void updateIntakeSettings({ captionStyle: s });
  };

  const [imageEdit, setImageEdit] = useState('');

  const currentVoice = (state.project?.voice_name ?? 'Adam') as SpeakerVoice;
  const [voiceDraft, setVoiceDraft] = useState<SpeakerVoice>(currentVoice);
  useEffect(() => { setVoiceDraft(currentVoice); }, [currentVoice]);

  const language = state.project?.voice_inclination ?? 'en';
  const voiceOptions = getSpeakersForLanguage(language);

  // Voice preview — uses the shared `getSampleText` helper so the
  // preview is always localised (Gemini voices especially need pure
  // French / Spanish input to pronounce properly; mixed-language input
  // is what was producing the half-French / half-English garbling).
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const playVoicePreview = async (voiceId: string) => {
    if (previewPlaying === voiceId) { setPreviewPlaying(null); return; }
    if (!user) return;
    setPreviewLoading(voiceId);
    try {
      const sampleText = getSampleText(prettyVoiceName(voiceId), language);
      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          task_type: 'voice_preview',
          payload: { speaker: voiceId, language, text: sampleText } as unknown as never,
          status: 'pending',
        }).select('id').single();
      if (error || !job) throw new Error('queue failed');
      const deadline = Date.now() + 22_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const { data: row } = await supabase
          .from('video_generation_jobs').select('status, result').eq('id', job.id).single();
        const url = (row?.result as { audioUrl?: string } | null)?.audioUrl;
        if (row?.status === 'completed' && url) {
          const audio = new Audio(url);
          setPreviewPlaying(voiceId);
          audio.onended = () => setPreviewPlaying(null);
          audio.onerror = () => setPreviewPlaying(null);
          audio.play().catch(() => setPreviewPlaying(null));
          break;
        }
        if (row?.status === 'failed') throw new Error('preview failed');
      }
    } catch {
      toast.error("Voice preview unavailable — try another voice if this one keeps failing.");
    } finally {
      setPreviewLoading(null);
    }
  };

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

      {/* SCENE TAB — prompt + image/video/voice actions + cast (read-only).
          Shot + Duration moved to Motion tab per product request. */}
      {!disabled && tab === 'scene' && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Prompt</h5>
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
              >
                {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
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

          {/* Per-asset regen: edit image / regen image / regen video.
              No Voice here — use the Voice tab for narration work so
              we don't duplicate the same action in two places. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Visuals</h5>
            <input
              value={imageEdit}
              onChange={(e) => setImageEdit(e.target.value)}
              placeholder="Edit this frame (e.g. add a lens flare, darker sky…)"
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
            />
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                onClick={() => { regenerateImage(selectedSceneIndex, imageEdit.trim() || undefined); setImageEdit(''); }}
                disabled={busy !== 'idle'}
                className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11.5px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                title={imageEdit.trim() ? 'Edit image with the prompt above' : 'Regenerate image only'}
              >
                {imageEdit.trim() ? <Wand2 className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
                {imageEdit.trim() ? 'Edit image' : 'Regenerate image'}
              </button>
              <button
                type="button"
                onClick={() => regenerateVideo(selectedSceneIndex)}
                disabled={busy !== 'idle' || !scene.imageUrl}
                className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11.5px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Re-render video from the current image"
              >
                <Video className="w-3 h-3" />
                Regenerate video
              </button>
            </div>
          </section>

          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Cast in scene</h5>
            {state.project?.character_description ? (
              <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-white/5 bg-[#1B2228]">
                <div className="w-8 h-8 rounded-full grid place-items-center bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] font-serif font-semibold text-[13px]">
                  {(state.project.character_description?.[0] ?? '?').toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-[#ECEAE4] truncate">Character (locked)</div>
                  <div className="font-mono text-[9px] text-[#5A6268] tracking-wider uppercase truncate">
                    {state.project.character_description.slice(0, 48)}
                  </div>
                </div>
                <Lock className="w-3.5 h-3.5 text-[#14C8CC]" />
              </div>
            ) : (
              <div className="text-[11.5px] text-[#8A9198] italic">No character set for this project.</div>
            )}
            <button
              type="button"
              disabled
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-dashed border-white/10 text-[#5A6268] cursor-not-allowed"
              title="Per-scene cast roster is coming soon"
            >
              <UserPlus className="w-3 h-3" />
              Add character
            </button>
          </section>
        </div>
      )}

      {/* VOICE TAB — editable narration + current-audio player +
          voice picker with preview + Save & Regenerate. Mirrors the
          legacy CinematicEditModal audio section so users don't lose
          the "listen to current, edit text, regenerate" flow. */}
      {!disabled && tab === 'voice' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {/* Editable narration */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Narration text</h5>
            <textarea
              value={voiceoverDraft}
              onChange={(e) => setVoiceoverDraft(e.target.value)}
              rows={5}
              placeholder="Type the narration for this scene…"
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12.5px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 resize-y leading-[1.55]"
            />
          </section>

          {/* Current audio player — native <audio controls> so users
              can scrub / adjust volume without us rebuilding transport. */}
          {scene.audioUrl && (
            <section>
              <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Current audio</h5>
              <audio
                key={scene.audioUrl}
                controls
                preload="none"
                src={scene.audioUrl}
                className="w-full h-9 [&::-webkit-media-controls-panel]:bg-[#1B2228]"
              />
            </section>
          )}

          {/* Save & Regenerate — runs if the user edited the text OR
              just hits it again with the same text to retry TTS. */}
          <button
            type="button"
            onClick={() => regenerateAudio(selectedSceneIndex, voiceoverDirty ? voiceoverDraft : undefined)}
            disabled={busy !== 'idle' || voiceoverDraft.trim().length < 2}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'regen' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
            {voiceoverDirty ? 'Save & Regenerate audio' : 'Regenerate audio'}
          </button>

          {/* Voice picker */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Voice</h5>
            <div className="flex items-center gap-2">
              <select
                value={voiceDraft}
                onChange={(e) => setVoiceDraft(e.target.value as SpeakerVoice)}
                className="flex-1 bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12.5px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50"
              >
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.label} · {v.description}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => playVoicePreview(voiceDraft)}
                disabled={previewLoading !== null && previewLoading !== voiceDraft}
                title={previewPlaying === voiceDraft ? 'Stop preview' : 'Listen to this voice'}
                className="w-9 h-9 rounded-full border border-[#14C8CC]/30 text-[#14C8CC] grid place-items-center hover:bg-[#14C8CC]/10 transition-colors disabled:opacity-40"
              >
                {previewLoading === voiceDraft
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : previewPlaying === voiceDraft
                    ? <Square className="w-3 h-3 fill-current" />
                    : <AudioLines className="w-3.5 h-3.5" />}
              </button>
            </div>
            <div className="font-mono text-[10px] text-[#5A6268] tracking-wider mt-1.5 uppercase">
              Current: {prettyVoiceName(currentVoice)} · {language.toUpperCase()}
            </div>

            <div className="grid grid-cols-2 gap-2 mt-3">
              <button
                type="button"
                onClick={() => updateProjectVoice(voiceDraft, false)}
                disabled={busy !== 'idle' || voiceDraft === currentVoice}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Set voice for new scenes only"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Re-render every scene's narration with ${prettyVoiceName(voiceDraft)}? This queues ${state.scenes.length} audio jobs.`)) {
                    updateProjectVoice(voiceDraft, true);
                  }
                }}
                disabled={busy !== 'idle' || voiceDraft === currentVoice}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50"
                title={`Switch voice AND regenerate all ${state.scenes.length} scenes`}
              >
                {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Update all
              </button>
            </div>
          </section>
        </div>
      )}

      {/* CAPTIONS TAB — PROJECT-level (apply to the whole video).
          Switching per-scene was confusing; users want one knob that
          controls captions across every scene. Optimistic local state
          so the toggle + dropdown respond instantly (no waiting on
          Supabase round-trip). */}
      {!disabled && tab === 'captions' && sceneReady && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <div className="flex items-center justify-between mb-2 gap-3">
              <div className="min-w-0">
                <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">
                  Captions on video
                </h5>
                <p className="text-[11px] text-[#8A9198] leading-[1.45] mt-0.5">
                  Burned into the export, applies to every scene.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={captionsOn}
                onClick={toggleCaptions}
                className={cn(
                  'relative w-10 h-5 rounded-full transition-colors shrink-0 border',
                  captionsOn ? 'bg-[#14C8CC] border-transparent' : 'bg-[#1B2228] border-white/10',
                )}
              >
                <span className={cn(
                  'absolute top-[1px] w-4 h-4 rounded-full transition-all',
                  captionsOn ? 'left-[22px] bg-[#0A0D0F]' : 'left-[1px] bg-[#8A9198]',
                )} />
              </button>
            </div>
          </section>

          {/* Native select — reliable on desktop + mobile, no portal
              stacking issues. Shows "Off" in the list so users can
              disable captions from the dropdown too. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Caption style
            </h5>
            <select
              value={captionStyleDraft}
              onChange={(e) => setCaptionStyle(e.target.value as CaptionStyle)}
              disabled={!captionsOn && captionStyleDraft === 'none'}
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 disabled:opacity-50"
            >
              <option value="none">Off</option>
              {captionStyles
                .filter((s) => s.id !== 'none')
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
            </select>
            <p className="font-mono text-[9.5px] text-[#5A6268] tracking-wider mt-2 uppercase">
              {captionsOn
                ? `Active · ${captionStyles.find((c) => c.id === captionStyleDraft)?.label ?? 'default'}`
                : 'Off · no captions will be burned in'}
            </p>
          </section>

          <button
            type="button"
            onClick={() => {
              toast.success(
                captionsOn
                  ? 'Captions will be burned in on your next export.'
                  : 'Captions are off for this project.'
              );
            }}
            disabled={busy !== 'idle'}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Captions are applied during export; no worker job needed"
          >
            <RotateCw className="w-3 h-3" />
            {captionsOn ? 'Confirm captions' : 'Captions disabled'}
          </button>
        </div>
      )}

      {/* MOTION TAB — per-scene motion + transition to next scene */}
      {!disabled && tab === 'motion' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Camera motion</h5>
            <div className="inline-flex rounded-lg border border-white/5 bg-[#1B2228] p-[2px] gap-[2px] w-full">
              {MOTION_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => updateSceneMeta(selectedSceneIndex, { motion: m })}
                  className={cn(
                    'flex-1 px-2 py-1.5 font-mono text-[10.5px] tracking-wider rounded-md transition-colors',
                    m === motion ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#8A9198] hover:text-[#ECEAE4]',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-[#8A9198] leading-[1.5] mt-2">
              Injected into the Kling prompt on the next video regeneration.
            </p>
          </section>

          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Transition to next scene</h5>
            <div className="inline-flex rounded-lg border border-white/5 bg-[#1B2228] p-[2px] gap-[2px] w-full">
              {TRANSITION_OPTIONS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => updateSceneMeta(selectedSceneIndex, { transition: t })}
                  className={cn(
                    'flex-1 px-2 py-1.5 font-mono text-[10.5px] tracking-wider rounded-md transition-colors',
                    t === transition ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#8A9198] hover:text-[#ECEAE4]',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-[#8A9198] leading-[1.5] mt-2">
              Applied when the video is exported. "Cut" is instant; "Dissolve" / "Whip" / "Black" cross-fade at the scene boundary.
            </p>
          </section>

          <button
            type="button"
            onClick={() => regenerateVideo(selectedSceneIndex)}
            disabled={busy !== 'idle' || !scene.imageUrl}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
            Re-render video with new motion
          </button>
        </div>
      )}

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
