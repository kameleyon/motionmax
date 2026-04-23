import { useState, useEffect } from 'react';
import { RotateCw, Loader2, Video, Image as ImageIcon, Wand2, Lock, UserPlus, AudioLines, Square, Undo2, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  getSpeakersForLanguage,
  getSampleText,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';
import { CaptionStyleSelector, type CaptionStyle } from '@/components/workspace/CaptionStyleSelector';
import { SceneVersionHistory } from '@/components/workspace/SceneVersionHistory';
import { useSceneVersionCount } from '@/hooks/useSceneVersions';
import { useActiveJobs } from './useActiveJobs';
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
    undoLastRegen,
    updateSceneMeta, updateAllScenesMeta, updateProjectVoice, updateIntakeSettings,
    applyCaptionsAll, regenerateAllVideos,
  } = useSceneRegen(state);
  const { tasksForScene, bulkAudioRegenActive, bulkOpActive, bulkOpKind } =
    useActiveJobs(state.project?.id ?? null);
  const sceneTasks = tasksForScene(selectedSceneIndex);
  const imageRegenActive = sceneTasks.has('regenerate_image') || sceneTasks.has('cinematic_image');
  const videoRegenActive = sceneTasks.has('cinematic_video');
  const audioRegenActive = sceneTasks.has('regenerate_audio');

  // Per-scene lock: only blocks edits to THIS scene while ITS regen is
  // in flight. A regen on scene 5 doesn't lock scene 1 here. The
  // project-wide lock (bulkOpActive) is separate and DOES lock all
  // scenes — that's the export / voice-apply-all / captions-apply path.
  const sceneLocked = imageRegenActive || videoRegenActive || audioRegenActive;
  const projectLocked = bulkOpActive;
  const projectLockLabel =
    bulkOpKind === 'export'
      ? 'Exporting full video · edits locked'
      : bulkOpKind === 'captions-apply'
        ? 'Burning captions across all scenes · edits locked'
        : bulkOpKind === 'voice-apply-all'
          ? 'Re-rendering every voiceover · edits locked'
          : bulkOpKind === 'motion-apply-all'
            ? 'Applying motion to every scene · edits locked'
            : 'Project re-rendering · edits locked';
  const projectType = state.project?.project_type ?? 'cinematic';
  const isCinematic = projectType === 'cinematic';
  const isExplainer = projectType === 'doc2video';

  // Version history modal
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: versionCount = 0 } = useSceneVersionCount(state.generation?.id, selectedSceneIndex);

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

  // Smart Flow has no per-scene motion controls — those are baked
  // into the SmartFlow render pipeline. Hide the tab entirely so it
  // doesn't surface a confusing empty panel.
  const isSmartFlow = projectType === 'smartflow';
  const visibleTabs: InspectorTab[] = isSmartFlow
    ? ['scene', 'voice', 'captions']
    : ['scene', 'voice', 'captions', 'motion'];

  // If the user is on Motion when we hide it, send them to Scene.
  useEffect(() => {
    if (isSmartFlow && tab === 'motion') setTab('scene');
  }, [isSmartFlow, tab]);

  // Defaults from the original generation — used by the Clear button
  // to revert a scene's overridden meta back to the project default.
  // intake.camera holds the user's original camera-motion choice;
  // transition wasn't part of intake (it's exposed in the editor for
  // the first time), so its default is "Cut" — the export's no-op
  // boundary that matches the legacy concat behaviour.
  const intakeCamera = (state.intake.camera as Motion | undefined) ?? 'Push-in';
  const defaultTransition: Transition = 'Cut';

  const clearSceneMotion = async () => {
    const ok = await updateSceneMeta(selectedSceneIndex, { motion: intakeCamera });
    if (ok) toast.success(`Camera motion reset to "${intakeCamera}" (project default).`);
  };
  const clearSceneTransition = async () => {
    const ok = await updateSceneMeta(selectedSceneIndex, { transition: defaultTransition });
    if (ok) toast.success(`Transition reset to "${defaultTransition}".`);
  };

  return (
    <div className="flex flex-col h-full relative">
      {/* Tabs */}
      <div className="flex border-b border-white/5">
        {visibleTabs.map((t) => (
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

      {/* Version-history toolbar — only visible post-render. Undo button
          walks the scene back one step; History button opens the
          SceneVersionHistory modal with every past state. */}
      {!disabled && scene && state.generation && state.project && versionCount > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-white/5 bg-[#10151A]/60">
          <button
            type="button"
            onClick={() => undoLastRegen(selectedSceneIndex)}
            disabled={busy !== 'idle' || sceneLocked}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-mono tracking-wider text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed uppercase"
            title="Restore this scene to its previous version"
          >
            {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
            Undo
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            disabled={busy !== 'idle' || sceneLocked}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-mono tracking-wider text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-40 uppercase ml-auto"
            title="Browse all past versions of this scene"
          >
            <History className="w-3 h-3" />
            History ({versionCount})
          </button>
        </div>
      )}

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
                disabled={busy !== 'idle' || imageRegenActive || promptDraft.trim().length < 6}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {(busy === 'regen' || imageRegenActive) ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
                {imageRegenActive ? 'Regenerating…' : 'Regenerate'}
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

          {/* Per-asset actions. Three distinct buttons so each
              affordance is obvious:
                Edit image  → uses Nano Banana Edit with the text above
                Regenerate  → full image regen from the scene prompt
                Video       → re-render the video from the current image.
              No Voice button here — that lives in the Voice tab. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Visuals</h5>
            <input
              value={imageEdit}
              onChange={(e) => setImageEdit(e.target.value)}
              placeholder="Describe the edit (e.g. add a lens flare, darker sky…)"
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
            />
            <div className="grid grid-cols-3 gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  const text = imageEdit.trim();
                  if (!text) { toast.info('Type the edit you want first.'); return; }
                  regenerateImage(selectedSceneIndex, text);
                  setImageEdit('');
                }}
                disabled={busy !== 'idle' || imageRegenActive || !scene.imageUrl}
                className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] border border-[#14C8CC]/30 bg-[#14C8CC]/5 text-[#14C8CC] hover:bg-[#14C8CC]/10 transition-colors disabled:opacity-50"
                title="Edit the current image with Nano Banana (natural-language edit)"
              >
                {imageRegenActive ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                Edit
              </button>
              <button
                type="button"
                onClick={() => regenerateImage(selectedSceneIndex)}
                disabled={busy !== 'idle' || imageRegenActive}
                className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Regenerate image from the scene prompt"
              >
                {imageRegenActive
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <ImageIcon className="w-3 h-3" />}
                Image
              </button>
              <button
                type="button"
                onClick={() => regenerateVideo(selectedSceneIndex)}
                disabled={busy !== 'idle' || videoRegenActive || !scene.imageUrl}
                className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Re-render video from the current image"
              >
                {videoRegenActive ? <Loader2 className="w-3 h-3 animate-spin" /> : <Video className="w-3 h-3" />}
                Video
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

          {/* Audio-bed toggles — per-scene switches that tell the
              export pipeline to skip music / sfx for this scene. No
              regen needed: export reads scene._meta on the next run
              and just doesn't mix those stems in. "With or without" —
              simple toggles, no slider. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Audio bed for this scene</h5>
            <div className="flex flex-col gap-1.5">
              <AudioBedToggle
                label="Background music"
                sub="Mute the Lyria bed under this scene"
                enabled={!(meta.muteMusic as boolean | undefined)}
                onToggle={(on) => updateSceneMeta(selectedSceneIndex, { muteMusic: !on })}
                disabled={busy !== 'idle' || sceneLocked || projectLocked}
              />
              <AudioBedToggle
                label="Sound effects"
                sub="Mute the per-scene SFX stems"
                enabled={!(meta.muteSfx as boolean | undefined)}
                onToggle={(on) => updateSceneMeta(selectedSceneIndex, { muteSfx: !on })}
                disabled={busy !== 'idle' || sceneLocked || projectLocked}
              />
            </div>
            <p className="font-mono text-[9.5px] text-[#5A6268] tracking-wider mt-2 uppercase">
              Applied on next export · no regeneration needed
            </p>
          </section>
        </div>
      )}

      {/* VOICE TAB — editable narration + current-audio player +
          voice picker with preview + Save & Regenerate. Mirrors the
          legacy CinematicEditModal audio section so users don't lose
          the "listen to current, edit text, regenerate" flow. */}
      {!disabled && tab === 'voice' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {/* Editable narration. Disabled + animated overlay while the
              audio is regenerating so the user can't edit mid-render
              (that would race the worker's write-back) and also sees
              visible "something is happening" feedback. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Narration text</h5>
            <div className="relative">
              <textarea
                value={voiceoverDraft}
                onChange={(e) => setVoiceoverDraft(e.target.value)}
                rows={5}
                placeholder="Type the narration for this scene…"
                disabled={audioRegenActive}
                className={cn(
                  'w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12.5px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 resize-y leading-[1.55]',
                  audioRegenActive && 'opacity-50 cursor-not-allowed',
                )}
              />
              {audioRegenActive && (
                <div className="absolute inset-0 rounded-lg pointer-events-none overflow-hidden">
                  {/* Shimmer sweep */}
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(110deg, transparent 0%, rgba(20,200,204,.08) 40%, rgba(20,200,204,.22) 50%, rgba(20,200,204,.08) 60%, transparent 100%)',
                      backgroundSize: '200% 100%',
                      animation: 'shimmer 1.8s ease-in-out infinite',
                    }}
                  />
                  {/* Centered status chip */}
                  <div className="absolute inset-0 grid place-items-center">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#10151A]/90 border border-[#14C8CC]/40 backdrop-blur-sm">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#14C8CC]" />
                      <span className="font-mono text-[10.5px] tracking-wider uppercase text-[#14C8CC]">
                        Generating audio…
                      </span>
                    </div>
                  </div>
                  <style>{`
                    @keyframes shimmer {
                      0%   { background-position: 200% 0; }
                      100% { background-position: -200% 0; }
                    }
                  `}</style>
                </div>
              )}
            </div>
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
            disabled={busy !== 'idle' || audioRegenActive || voiceoverDraft.trim().length < 2}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {(busy === 'regen' || audioRegenActive) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
            {audioRegenActive ? 'Generating audio…' : (voiceoverDirty ? 'Save & Regenerate audio' : 'Regenerate audio')}
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

            {/* One-click "Apply to all & regenerate" — flips the project
                voice AND queues a bulk regenerate_audio for every
                scene with narration. The old split ("Apply" for new
                scenes vs "Update all" for regenerate) was confusing:
                users clicked Apply expecting regeneration. Single
                button, clear intent. */}
            <button
              type="button"
              onClick={() => {
                if (voiceDraft === currentVoice) return;
                if (window.confirm(`Apply ${prettyVoiceName(voiceDraft)} to all scenes and regenerate every narration? This queues ${state.scenes.length} audio jobs and locks editing while it runs.`)) {
                  updateProjectVoice(voiceDraft, true);
                }
              }}
              disabled={busy !== 'idle' || bulkAudioRegenActive || projectLocked || voiceDraft === currentVoice}
              className="w-full mt-3 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50"
              title={`Switch voice AND regenerate all ${state.scenes.length} scenes`}
            >
              {(busy === 'regen' || bulkAudioRegenActive) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCw className="w-3.5 h-3.5" />}
              {bulkAudioRegenActive ? `Rendering all (${state.scenes.length})…` : 'Apply to all & regenerate'}
            </button>
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

          {/* Same CaptionStyleSelector used on the intake form — shows
              animated per-style preview rows ("Your idea in motion").
              This is the component the user is already familiar with
              from the generation flow; no point reinventing it here. */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">
              Caption style
            </h5>
            <div className="bg-[#1B2228] border border-white/5 rounded-lg px-2 py-1.5">
              <CaptionStyleSelector
                value={captionStyleDraft}
                onChange={(v) => setCaptionStyle(v)}
                showLabel={false}
              />
            </div>
            <p className="font-mono text-[9.5px] text-[#5A6268] tracking-wider mt-2 uppercase">
              {captionsOn ? 'Applies to every scene on export' : 'Off · no captions will be burned in'}
            </p>
          </section>

          {/* Apply captions = re-render the full video with captions
              burned across every scene. Triggers a project-wide lock
              (bulkOpActive) so the timeline + every scene panel are
              shielded for the duration. */}
          <button
            type="button"
            onClick={async () => {
              if (!captionsOn) {
                toast.info('Captions are currently off — toggle on, pick a style, then Apply.');
                return;
              }
              await applyCaptionsAll(captionStyleDraft);
            }}
            disabled={busy !== 'idle' || !captionsOn || projectLocked}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12.5px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed',
              captionsOn
                ? 'text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105'
                : 'border border-white/10 text-[#ECEAE4] hover:bg-white/5',
            )}
            title={captionsOn ? 'Re-render the full video with captions burned in' : 'Captions are disabled'}
          >
            {projectLocked && bulkOpKind === 'captions-apply'
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RotateCw className="w-3.5 h-3.5" />}
            {projectLocked && bulkOpKind === 'captions-apply'
              ? 'Burning captions…'
              : (captionsOn ? 'Apply captions' : 'Captions disabled')}
          </button>
        </div>
      )}

      {/* MOTION TAB — split by project type:
          • Cinematic → Camera motion ONLY (no transition; cinematic
            scenes flow into each other via Kling's own continuity).
          • Explainer → Transition ONLY (no camera motion; explainer
            scenes are still images concatenated at export time).
          • SmartFlow → tab is hidden entirely (see visibleTabs above).
          Each section gets a Clear button that resets THIS scene to
          the project's intake default — so users can experiment per
          scene then revert without remembering what was originally
          generated. */}
      {!disabled && tab === 'motion' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {isCinematic && (
            <>
              <section>
                <div className="flex items-baseline justify-between mb-2 gap-3">
                  <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Camera motion</h5>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={clearSceneMotion}
                      disabled={busy !== 'idle' || sceneLocked || projectLocked}
                      className="font-mono text-[9.5px] tracking-wider uppercase text-[#8A9198] hover:text-[#ECEAE4] transition-colors disabled:opacity-40"
                      title={`Reset this scene to the project default (${intakeCamera})`}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await updateAllScenesMeta({ motion });
                        if (ok) toast.success(`Camera motion "${motion}" applied to all ${state.scenes.length} scenes.`);
                      }}
                      disabled={busy !== 'idle' || projectLocked}
                      className="font-mono text-[9.5px] tracking-wider uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors disabled:opacity-40"
                      title="Use this camera motion on every scene"
                    >
                      Apply to all
                    </button>
                  </div>
                </div>
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
                  Injected into the Kling prompt on the next video regeneration. "Clear" reverts this scene to the project default ({intakeCamera}).
                </p>
              </section>

              {/* Two re-render paths:
                  • Primary "Re-render all" → bulk: queues a
                    cinematic_video job for every scene with an image,
                    each tagged _bulk: 'motion-apply-all'. Trips
                    bulkOpActive so every scene in ScenesColumn shows
                    its own loader, every Timeline clip stripes, and
                    Inspector overlays with the bulk message.
                  • Secondary "just this scene" → per-scene only;
                    only this scene locks. */}
              <button
                type="button"
                onClick={async () => {
                  if (window.confirm(`Re-render every scene's video with the current motion settings? This queues ${state.scenes.length} video jobs and locks editing while it runs.`)) {
                    await regenerateAllVideos();
                  }
                }}
                disabled={busy !== 'idle' || projectLocked}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {projectLocked && bulkOpKind === 'motion-apply-all'
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RotateCw className="w-3.5 h-3.5" />}
                {projectLocked && bulkOpKind === 'motion-apply-all'
                  ? `Re-rendering all (${state.scenes.length})…`
                  : `Re-render all videos with new motion`}
              </button>
              <button
                type="button"
                onClick={() => regenerateVideo(selectedSceneIndex)}
                disabled={busy !== 'idle' || videoRegenActive || !scene.imageUrl || projectLocked}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed -mt-2"
                title="Only re-render the current scene"
              >
                {(busy === 'regen' || videoRegenActive) ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
                {videoRegenActive ? 'Rendering this scene…' : 'or just this scene'}
              </button>
            </>
          )}

          {isExplainer && (
            <section>
              <div className="flex items-baseline justify-between mb-2 gap-3">
                <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Transition to next scene</h5>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={clearSceneTransition}
                    disabled={busy !== 'idle' || sceneLocked || projectLocked}
                    className="font-mono text-[9.5px] tracking-wider uppercase text-[#8A9198] hover:text-[#ECEAE4] transition-colors disabled:opacity-40"
                    title={`Reset this scene to the default (${defaultTransition})`}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await updateAllScenesMeta({ transition });
                      if (ok) toast.success(`Transition "${transition}" applied to all ${state.scenes.length} scenes.`);
                    }}
                    disabled={busy !== 'idle' || projectLocked}
                    className="font-mono text-[9.5px] tracking-wider uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors disabled:opacity-40"
                    title="Use this transition on every scene boundary"
                  >
                    Apply to all
                  </button>
                </div>
              </div>
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
                Applied when the video is exported. "Cut" is instant; "Dissolve" / "Whip" / "Black" cross-fade at the scene boundary. "Clear" reverts this scene to the default ({defaultTransition}).
              </p>
            </section>
          )}
        </div>
      )}

      {!disabled && !scene && (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="text-[12px] text-[#8A9198]">
            Select a scene on the left to edit its prompt, voice, or captions.
          </div>
        </div>
      )}

      {/* Lock overlay — two flavours, project-wide takes priority:
          • projectLocked (export / voice-apply-all / captions-apply /
            motion-apply-all) shields the whole inspector with a label
            describing which bulk op is running.
          • sceneLocked (per-scene regen) shields only this scene's
            panel; other scenes remain freely editable thanks to the
            timeline's per-clip lock + Inspector being scene-scoped. */}
      {(projectLocked || sceneLocked) && (
        <div className="absolute inset-0 z-10 bg-[#0A0D0F]/65 backdrop-blur-[1px] grid place-items-center pointer-events-auto">
          <div className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-[#10151A]/95 border border-[#14C8CC]/40 shadow-lg">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#14C8CC]" />
            <span className="font-mono text-[11px] tracking-wider uppercase text-[#14C8CC]">
              {projectLocked ? projectLockLabel : 'Scene regenerating · edits locked'}
            </span>
          </div>
        </div>
      )}

      {/* Version history modal */}
      {historyOpen && state.generation && state.project && scene && (
        <SceneVersionHistory
          generationId={state.generation.id}
          projectId={state.project.id}
          sceneIndex={selectedSceneIndex}
          sceneName={scene.title || `Scene ${selectedSceneIndex + 1}`}
          onClose={() => setHistoryOpen(false)}
          onVersionRestored={() => { setHistoryOpen(false); }}
        />
      )}
    </div>
  );
}

/** Per-scene audio-bed toggle. Styled to match the Captions on/off
 *  switch so the tab feels cohesive. `enabled` maps to "keep this
 *  bed in the export"; toggling OFF writes muteMusic / muteSfx into
 *  scene._meta, which export reads and skips. No regen required. */
function AudioBedToggle({
  label, sub, enabled, onToggle, disabled,
}: {
  label: string;
  sub: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2 rounded-lg border border-white/5 bg-[#1B2228]">
      <div className="min-w-0">
        <div className="text-[12.5px] text-[#ECEAE4] leading-tight">{label}</div>
        <div className="text-[11px] text-[#8A9198] mt-0.5">{sub}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => onToggle(!enabled)}
        className={cn(
          'relative w-10 h-5 rounded-full transition-colors shrink-0 border disabled:opacity-40',
          enabled ? 'bg-[#14C8CC] border-transparent' : 'bg-[#0A0D0F] border-white/10',
        )}
      >
        <span className={cn(
          'absolute top-[1px] w-4 h-4 rounded-full transition-all',
          enabled ? 'left-[22px] bg-[#0A0D0F]' : 'left-[1px] bg-[#8A9198]',
        )} />
      </button>
    </div>
  );
}
