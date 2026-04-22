import { useState, useEffect } from 'react';
import { RotateCw, Loader2, Video, Image as ImageIcon, Wand2, Lock, UserPlus, Play, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  getSpeakersForLanguage,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';
import type { EditorState } from '@/hooks/useEditorState';
import { useSceneRegen } from './useSceneRegen';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

type InspectorTab = 'scene' | 'voice' | 'captions' | 'motion';

type Lens = '24mm' | '35mm' | '50mm' | '85mm';
type Motion = 'Still' | 'Push-in' | 'Pan' | 'Dolly';

const LENS_OPTIONS: Lens[] = ['24mm', '35mm', '50mm', '85mm'];
const MOTION_OPTIONS: Motion[] = ['Still', 'Push-in', 'Pan', 'Dolly'];

/** Strip the sm:/sm2:/gm: provider prefix for display. */
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
    updateSceneMeta, updateProjectVoice,
  } = useSceneRegen(state);

  // Prompt buffer (Scene tab).
  const [promptDraft, setPromptDraft] = useState(scene?.visualPrompt ?? '');
  useEffect(() => {
    setPromptDraft(scene?.visualPrompt ?? '');
  }, [selectedSceneIndex, scene?.visualPrompt]);
  const dirty = promptDraft.trim() !== (scene?.visualPrompt ?? '').trim();

  // Shot params — stored in scene._meta.
  const meta = scene?.meta ?? {};
  const lens = (meta.lens as Lens | undefined) ?? '50mm';
  const motion = (meta.motion as Motion | undefined) ?? 'Push-in';
  const aperture = typeof meta.aperture === 'number' ? (meta.aperture as number) : 1.8;
  const grain = typeof meta.grain === 'number' ? (meta.grain as number) : 35;
  const duration = ((scene?.audioDurationMs ?? scene?.estDurationMs ?? 10_000) / 1000);
  const durationOverride = typeof meta.durationOverride === 'number' ? (meta.durationOverride as number) : null;

  // Image edit prompt buffer.
  const [imageEdit, setImageEdit] = useState('');

  // Voice tab local state.
  const currentVoice = (state.project?.voice_name ?? 'Adam') as SpeakerVoice;
  const [voiceDraft, setVoiceDraft] = useState<SpeakerVoice>(currentVoice);
  useEffect(() => { setVoiceDraft(currentVoice); }, [currentVoice]);

  const language = state.project?.voice_inclination ?? 'en';
  const voiceOptions = getSpeakersForLanguage(language);

  // Voice preview playback (reuses the same voice_preview worker task as SpeakerSelector).
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const playVoicePreview = async (voiceId: string) => {
    if (previewPlaying) {
      // Stop handled implicitly — we only keep the most recent audio element.
      setPreviewPlaying(null);
      return;
    }
    if (!user) return;
    setPreviewLoading(voiceId);
    try {
      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          task_type: 'voice_preview',
          payload: { speaker: voiceId, language, text: `Hello, I'm ${prettyVoiceName(voiceId)}.` } as unknown as never,
          status: 'pending',
        }).select('id').single();
      if (error || !job) throw new Error('queue failed');
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const { data: row } = await supabase
          .from('video_generation_jobs').select('status, result').eq('id', job.id).single();
        const url = (row?.result as { audioUrl?: string } | null)?.audioUrl;
        if (row?.status === 'completed' && url) {
          const audio = new Audio(url);
          setPreviewPlaying(voiceId);
          audio.onended = () => setPreviewPlaying(null);
          audio.play().catch(() => setPreviewPlaying(null));
          break;
        }
        if (row?.status === 'failed') throw new Error('preview failed');
      }
    } catch {
      toast.error('Voice preview unavailable.');
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

      {/* Rendering overlay */}
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

      {/* SCENE TAB */}
      {!disabled && tab === 'scene' && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {/* Prompt + Apply / Regenerate (full scene = image → video) */}
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
                title="Save the prompt and re-render image + video"
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

          {/* Image + Video individual actions */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Visuals</h5>
            <div className="grid gap-2">
              <input
                value={imageEdit}
                onChange={(e) => setImageEdit(e.target.value)}
                placeholder="Edit this frame (e.g. add a lens flare, darker sky…)"
                className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2 text-[12px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
              />
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => { regenerateImage(selectedSceneIndex, imageEdit.trim() || undefined); setImageEdit(''); }}
                  disabled={busy !== 'idle'}
                  className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11.5px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                  title={imageEdit.trim() ? 'Edit image with the prompt above' : 'Regenerate image only'}
                >
                  {imageEdit.trim() ? <Wand2 className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
                  {imageEdit.trim() ? 'Edit' : 'Image'}
                </button>
                <button
                  type="button"
                  onClick={() => regenerateVideo(selectedSceneIndex)}
                  disabled={busy !== 'idle' || !scene.imageUrl}
                  className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11.5px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                  title="Regenerate video from the current image"
                >
                  <Video className="w-3 h-3" />
                  Video
                </button>
                <button
                  type="button"
                  onClick={() => regenerateAudio(selectedSceneIndex)}
                  disabled={busy !== 'idle'}
                  className="inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg text-[11.5px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50"
                  title="Regenerate narration audio for this scene"
                >
                  <RotateCw className="w-3 h-3" />
                  Voice
                </button>
              </div>
            </div>
          </section>

          {/* Shot params */}
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Shot</h5>

            <div className="mb-3">
              <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8A9198] mb-1.5">Lens</div>
              <div className="inline-flex rounded-lg border border-white/5 bg-[#1B2228] p-[2px] gap-[2px] w-full">
                {LENS_OPTIONS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => updateSceneMeta(selectedSceneIndex, { lens: l })}
                    className={cn(
                      'flex-1 px-2 py-1 font-mono text-[10.5px] tracking-wider rounded-md transition-colors',
                      l === lens ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#8A9198] hover:text-[#ECEAE4]',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3">
              <div className="font-mono text-[10px] tracking-[0.08em] uppercase text-[#8A9198] mb-1.5">Motion</div>
              <div className="inline-flex rounded-lg border border-white/5 bg-[#1B2228] p-[2px] gap-[2px] w-full">
                {MOTION_OPTIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateSceneMeta(selectedSceneIndex, { motion: m })}
                    className={cn(
                      'flex-1 px-2 py-1 font-mono text-[10.5px] tracking-wider rounded-md transition-colors',
                      m === motion ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#8A9198] hover:text-[#ECEAE4]',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-3">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] uppercase text-[#8A9198] mb-1.5">
                <span>Aperture</span>
                <span className="text-[#ECEAE4]">f/{aperture.toFixed(1)}</span>
              </div>
              <input
                type="range" min="1.2" max="16" step="0.1" value={aperture}
                onChange={(e) => updateSceneMeta(selectedSceneIndex, { aperture: parseFloat(e.target.value) })}
                className="w-full accent-[#14C8CC]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] uppercase text-[#8A9198] mb-1.5">
                <span>Grain</span>
                <span className="text-[#ECEAE4]">{grain}%</span>
              </div>
              <input
                type="range" min="0" max="100" step="1" value={grain}
                onChange={(e) => updateSceneMeta(selectedSceneIndex, { grain: parseInt(e.target.value, 10) })}
                className="w-full accent-[#14C8CC]"
              />
            </div>
            <p className="mt-2 font-mono text-[9.5px] text-[#5A6268] tracking-wider leading-[1.5]">
              Lens + motion + aperture + grain are injected into the Kling prompt on the next regenerate. They don't re-render until you hit Regenerate or Video.
            </p>
          </section>

          {/* Cast in scene */}
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

          {/* Duration */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Duration</h5>
              <span className="text-[12px] text-[#ECEAE4]">{(durationOverride ?? duration).toFixed(1)}s</span>
            </div>
            <input
              type="range" min="3" max="15" step="0.5"
              value={durationOverride ?? duration}
              onChange={(e) => updateSceneMeta(selectedSceneIndex, { durationOverride: parseFloat(e.target.value) })}
              className="w-full accent-[#14C8CC]"
            />
            <div className="font-mono text-[9.5px] text-[#5A6268] tracking-wider mt-1">
              {durationOverride
                ? 'Manual override · applied on next video regen'
                : 'Auto from narration · override to force a specific length'}
            </div>
          </section>
        </div>
      )}

      {/* VOICE TAB */}
      {!disabled && tab === 'voice' && sceneReady && scene && (
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          <section>
            <h5 className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] mb-2 font-medium">Narration text</h5>
            <div className="bg-[#1B2228] border border-white/5 rounded-lg p-3 text-[12.5px] text-[#ECEAE4] leading-[1.55] max-h-[160px] overflow-y-auto">
              {scene.voiceover?.trim() || <span className="text-[#5A6268] italic">No narration on this scene yet.</span>}
            </div>
          </section>

          {/* Voice switcher — the selected voice shows a clean label
              (prettyVoiceName strips sm:/gm: prefixes), the dropdown
              lists all voices in the project language. User can Apply
              to new scenes only, or Apply + Update all to re-render
              every scene with the new voice. */}
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
                disabled={previewLoading !== null}
                title={previewPlaying === voiceDraft ? 'Stop preview' : 'Preview voice'}
                className="w-9 h-9 rounded-full border border-[#14C8CC]/30 text-[#14C8CC] grid place-items-center hover:bg-[#14C8CC]/10 transition-colors disabled:opacity-40"
              >
                {previewLoading === voiceDraft
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : previewPlaying === voiceDraft
                    ? <Square className="w-3 h-3 fill-current" />
                    : <Play className="w-3 h-3 fill-current" />}
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
                onClick={() => updateProjectVoice(voiceDraft, true)}
                disabled={busy !== 'idle' || voiceDraft === currentVoice}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 disabled:opacity-50"
                title="Switch voice AND regenerate every scene's narration"
              >
                {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Update all
              </button>
            </div>
          </section>

          <button
            type="button"
            onClick={() => regenerateAudio(selectedSceneIndex)}
            disabled={busy !== 'idle' || !scene.audioUrl}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-white/10 text-[#ECEAE4] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'regen' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
            Regenerate this scene's voice
          </button>
        </div>
      )}

      {!disabled && tab === 'captions' && sceneReady && (
        <div className="flex-1 p-4 text-[12.5px] text-[#8A9198] leading-[1.6]">
          Per-scene caption style editing is coming soon. Current caption style:{' '}
          <span className="text-[#ECEAE4]">{state.intake.captionStyle ?? 'default'}</span>.
        </div>
      )}
      {!disabled && tab === 'motion' && sceneReady && (
        <div className="flex-1 p-4 text-[12.5px] text-[#8A9198] leading-[1.6]">
          Motion &amp; transitions (end-frame target, crossfade duration) coming soon.
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
