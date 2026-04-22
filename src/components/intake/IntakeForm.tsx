import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AudioLines, Music, Users, Sparkles, Camera, Palette, Link as LinkIcon, Paperclip,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  getDefaultSpeaker,
  getSpeakersForLanguage,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';
import {
  FEATURES, MODE_LABEL, COST_TABLE,
  type ProjectMode, type IntakeAspect, type IntakeDuration,
  type MusicGenre, type CameraMotion, type ColorGrade, type CastMember,
  type IntakeSettings,
} from './types';
import { IntakeField, IntakeLabel, IntakeSlider, Pill } from './primitives';
import FeatureToggle from './FeatureToggle';
import IntakeRail from './IntakeRail';
import { useIntakeRail } from './IntakeFrame';

/** Visual-style catalog pulled from the domain type. Backgrounds are
 *  illustrative gradients (not final artwork) — the design bundle used
 *  the same placeholder approach and we can swap to real thumbnail PNGs
 *  later without changing the form. */
const STYLES: Array<{ id: string; name: string; bg: string }> = [
  { id: 'realistic',  name: 'Realistic',   bg: 'linear-gradient(135deg,#7b8a96,#2b3640)' },
  { id: '3d-pixar',   name: '3D Pixar',    bg: 'linear-gradient(135deg,#ffd347,#2b7cd9)' },
  { id: 'anime',      name: 'Anime',       bg: 'linear-gradient(135deg,#ff9cc0,#3b54a8)' },
  { id: 'claymation', name: 'Claymation',  bg: 'linear-gradient(135deg,#c9a06b,#4a2d1a)' },
  { id: 'storybook',  name: 'Storybook',   bg: 'linear-gradient(135deg,#d8b597,#8a5a3e)' },
  { id: 'caricature', name: 'Caricature',  bg: 'linear-gradient(135deg,#f4a56f,#c96432)' },
  { id: 'doodle',     name: 'Doodle',      bg: 'linear-gradient(135deg,#fafafa,#cfd8dc)' },
  { id: 'stick',      name: 'Stick Figure',bg: 'linear-gradient(135deg,#fff,#e0e0e0)' },
  { id: 'sketch',     name: 'Sketch',      bg: 'linear-gradient(135deg,#e8e2d5,#8a8275)' },
  { id: 'crayon',     name: 'Crayon',      bg: 'linear-gradient(135deg,#ff7a7a,#ffde6b)' },
  { id: 'minimalist', name: 'Minimalist',  bg: 'linear-gradient(135deg,#f5f5f0,#bfbfb8)' },
  { id: 'moody',      name: 'Moody',       bg: 'radial-gradient(60% 70% at 40% 40%,#4a4a4a,#101010)' },
  { id: 'chalkboard', name: 'Chalkboard',  bg: 'linear-gradient(135deg,#1f3d2a,#0b1a12)' },
  { id: 'lego',       name: 'LEGO',        bg: 'linear-gradient(135deg,#ffd347,#e02424)' },
  { id: 'cardboard',  name: 'Cardboard',   bg: 'linear-gradient(135deg,#c9a06b,#7a5433)' },
  { id: 'babie',      name: 'Barbie',      bg: 'linear-gradient(135deg,#ff9ac8,#ffd1e8)' },
  { id: 'custom',     name: 'Custom',      bg: 'linear-gradient(135deg,#14C8CC33,#0FA6AE11)' },
];

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'ht', label: 'Kreyòl' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
];

const MUSIC_GENRES: MusicGenre[] = ['Cinematic', 'Electronic', 'Acoustic', 'Ambient', 'Hip-hop', 'Jazz', 'Orchestral'];
const CAMERA_MOTIONS: CameraMotion[] = ['Static', 'Dolly', 'Handheld', 'Drone', 'Crane', 'Whip Pan'];
const COLOR_GRADES: ColorGrade[] = ['Kodak 250D', 'Bleach Bypass', 'Teal & Orange', 'Warm Film', 'Cool Noir', 'Desaturated'];

const CAPTION_STYLES = ['Burned in · Minimal', 'Burned in · Karaoke', 'None'];

function aspectFromFormat(f: string): IntakeAspect {
  return f === 'portrait' ? '9:16' : '16:9';
}
function formatFromAspect(a: IntakeAspect): string {
  return a === '9:16' ? 'portrait' : 'landscape';
}

/** The big one — shared form across all three modes. Render-only decisions
 *  live in the FEATURES map so adding/removing a row for a given mode is
 *  a one-line change. */
export default function IntakeForm({
  mode,
  initialPrompt = '',
  initialLanguage = 'en',
  initialFormat = 'landscape',
  initialVoice = '',
}: {
  mode: ProjectMode;
  initialPrompt?: string;
  initialLanguage?: string;
  initialFormat?: string;
  initialVoice?: string;
}) {
  const features = FEATURES[mode];
  const { user } = useAuth();
  const navigate = useNavigate();

  // ── Core fields ──────────────────────────────────────────
  const [prompt, setPrompt] = useState(initialPrompt);
  const [aspect, setAspect] = useState<IntakeAspect>(aspectFromFormat(initialFormat));
  const [duration, setDuration] = useState<IntakeDuration>('<3min');
  const [language, setLanguage] = useState(initialLanguage);
  const [voice, setVoice] = useState<SpeakerVoice>(
    (initialVoice as SpeakerVoice) || getDefaultSpeaker(initialLanguage),
  );
  const [caption, setCaption] = useState(CAPTION_STYLES[0]);
  const [brand, setBrand] = useState('');

  // ── Direction ─────────────────────────────────────────────
  const [styleId, setStyleId] = useState('realistic');
  const [tone, setTone] = useState(45);
  const [camera, setCamera] = useState<CameraMotion>('Dolly');
  const [grade, setGrade] = useState<ColorGrade>('Kodak 250D');

  // ── Feature toggles ───────────────────────────────────────
  const [lipSync, setLipSync] = useState(false);
  const [lipStrength, setLipStrength] = useState(70);
  const [music, setMusic] = useState(false);
  const [musicGenre, setMusicGenre] = useState<MusicGenre>('Cinematic');
  const [musicIntensity, setMusicIntensity] = useState(55);
  const [sfx, setSfx] = useState(false);
  const [consistency, setConsistency] = useState(features.cast);
  const [cast, setCast] = useState<CastMember[]>([]);
  const [characterAppearance, setCharacterAppearance] = useState('');

  const [generating, setGenerating] = useState(false);

  // Reset voice when language flips to one the current voice doesn't
  // support — mirrors the Hero behaviour so the two stay consistent.
  const speakersForLang = useMemo(() => getSpeakersForLanguage(language), [language]);
  useEffect(() => {
    if (!speakersForLang.some((s) => s.id === voice)) {
      setVoice(getDefaultSpeaker(language));
    }
  }, [language, speakersForLang, voice]);

  // ── Credits (for the "N available" meter) ────────────────
  const { data: credits } = useQuery({
    queryKey: ['intake-credits', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('user_credits').select('credits_balance').eq('user_id', user!.id).maybeSingle();
      return data;
    },
  });

  // ── Cost items (design-flat numbers for now) ─────────────
  const costItems = useMemo(() => {
    const items: Array<{ label: string; v: number }> = [{ label: 'Base generation', v: COST_TABLE.base }];
    if (features.duration && duration === '>3min') items.push({ label: 'Duration · > 3 min', v: COST_TABLE.durationLong });
    if (features.lipSync && lipSync) items.push({ label: 'Lip sync', v: COST_TABLE.lipSync });
    if (features.music && music) items.push({ label: `Music · ${musicGenre}`, v: COST_TABLE.music });
    if (features.sfx && music && sfx) items.push({ label: 'SFX & foley', v: COST_TABLE.sfx });
    if (features.cast && consistency) items.push({ label: 'Character consistency', v: COST_TABLE.cast });
    return items;
  }, [features, duration, lipSync, music, musicGenre, sfx, consistency]);

  const totalCost = costItems.reduce((a, x) => a + x.v, 0);

  // ── Bridge to the rail (right side on desktop, bottom sheet on mobile) ─
  const rail = useIntakeRail();
  useEffect(() => {
    rail.setTotalCost(totalCost);
    rail.setRailContent(
      <IntakeRail
        aspect={aspect}
        prompt={prompt}
        visualStyle={STYLES.find((s) => s.id === styleId) ?? STYLES[0]}
        camera={features.camera ? camera : undefined}
        grade={features.colorGrade ? grade : undefined}
        costItems={costItems}
        totalCost={totalCost}
        creditsAvailable={credits?.credits_balance ?? 0}
        onGenerate={handleGenerate}
        generating={generating}
      />,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect, prompt, styleId, camera, grade, costItems, totalCost, credits, generating]);

  // ── Generate handler ─────────────────────────────────────
  async function handleGenerate() {
    if (!user) { toast.error('Please sign in to continue.'); return; }
    if (prompt.trim().length < 6) { toast.error('Describe your video first (at least a short sentence).'); return; }

    setGenerating(true);
    try {
      const intakeSettings: IntakeSettings = {
        visualStyle: styleId,
        tone,
        ...(features.camera ? { camera } : {}),
        ...(features.colorGrade ? { grade } : {}),
        ...(features.lipSync && lipSync ? { lipSync: { on: true, strength: lipStrength } } : {}),
        ...(features.music && music ? {
          music: {
            on: true, genre: musicGenre, intensity: musicIntensity,
            sfx: features.sfx && sfx,
          },
        } : {}),
        ...(features.cast && consistency && cast.length > 0 ? { cast } : {}),
        ...(features.characterAppearance && characterAppearance ? { characterAppearance } : {}),
        captionStyle: caption,
        ...(brand.trim() ? { brandName: brand.trim() } : {}),
      };

      const title = prompt.trim().slice(0, 80);
      const length = features.duration && duration === '>3min' ? 'presentation' : 'short';

      const { data, error } = await supabase.from('projects').insert({
        user_id: user.id,
        title,
        content: prompt.trim(),
        project_type: mode,
        format: formatFromAspect(aspect),
        length,
        voice_name: voice,
        voice_inclination: language,
        style: styleId,
        character_description: characterAppearance || null,
        character_consistency_enabled: features.cast ? consistency : false,
        intake_settings: intakeSettings,
      }).select('id').single();

      if (error || !data) throw error || new Error('Insert returned no row');

      toast.success('Project created. Taking you to the editor…');
      navigate(`/app/create?project=${data.id}&autostart=1`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save project: ${msg}`);
    } finally {
      setGenerating(false);
    }
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); handleGenerate(); }}
      className="flex flex-col gap-6 sm:gap-7"
    >
      {/* Header */}
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#14C8CC]/10 text-[#14C8CC] font-mono text-[10.5px] tracking-[0.14em] uppercase">
          {MODE_LABEL[mode]}
        </span>
        <h1 className="font-serif font-medium text-[26px] sm:text-[32px] md:text-[34px] tracking-tight mt-3 mb-1.5 text-[#ECEAE4]">
          Create {MODE_LABEL[mode]} Video
        </h1>
        <p className="text-[13px] sm:text-[13.5px] text-[#8A9198] max-w-[52ch] mx-auto">
          {mode === 'cinematic' && 'Transform your idea into a cinematic, AI-generated video.'}
          {mode === 'doc2video' && 'Turn a document or rough outline into a clean explainer video.'}
          {mode === 'smartflow' && 'Fast, short-form reel — dial in the vibe, MotionMax does the rest.'}
        </p>
      </div>

      {/* Sources & Direction */}
      <div>
        <IntakeLabel>Sources & direction</IntakeLabel>
        <IntakeField className="p-0 overflow-hidden">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Describe your video idea, paste text, drop images, or add sources with +"
            className="w-full min-h-[100px] bg-transparent border-0 outline-none text-[#ECEAE4] font-serif text-[15px] sm:text-[16px] leading-[1.5] resize-y p-4"
          />
          <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-t border-white/5">
            <button type="button" className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-dashed border-white/10 rounded-md hover:text-[#ECEAE4]">
              + Add source
            </button>
            <button type="button" className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]">
              <Paperclip className="w-3 h-3" /> File
            </button>
            <button type="button" className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]">
              <LinkIcon className="w-3 h-3" /> URL
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => toast.info('Smart Prompt coming soon.')}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#14C8CC] px-2 py-1 border border-[#14C8CC]/30 rounded-md bg-[#14C8CC]/10 hover:bg-[#14C8CC]/20"
            >
              <Sparkles className="w-3 h-3" /> Smart prompt
            </button>
          </div>
        </IntakeField>
      </div>

      {/* Format + Duration */}
      <div className={`grid gap-4 sm:gap-5 ${features.duration ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        <div>
          <IntakeLabel>Format</IntakeLabel>
          <div className="flex gap-2">
            {(['16:9', '9:16'] as IntakeAspect[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAspect(a)}
                className={
                  'flex-1 px-3 py-2.5 rounded-lg inline-flex items-center justify-center gap-2 font-mono text-[11px] tracking-wider transition-colors ' +
                  (a === aspect
                    ? 'border border-[#14C8CC] bg-[#14C8CC]/10 text-[#14C8CC]'
                    : 'border border-white/5 bg-[#151B20] text-[#ECEAE4] hover:border-white/10')
                }
              >
                <div
                  className="border-[1.5px] border-current rounded-[2px]"
                  style={{ width: a === '16:9' ? 18 : 10, height: a === '16:9' ? 10 : 18 }}
                />
                {a}
              </button>
            ))}
          </div>
        </div>

        {features.duration && (
          <div>
            <IntakeLabel>Duration</IntakeLabel>
            <div className="flex gap-2">
              {([['<3min', '< 3 min'], ['>3min', '> 3 min']] as Array<[IntakeDuration, string]>).map(([v, t]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDuration(v)}
                  className={
                    'flex-1 px-3 py-2.5 rounded-lg font-mono text-[11px] tracking-wider transition-colors ' +
                    (v === duration
                      ? 'border border-[#14C8CC] bg-[#14C8CC]/10 text-[#14C8CC]'
                      : 'border border-white/5 bg-[#151B20] text-[#ECEAE4] hover:border-white/10')
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Language / Voice / Captions / Brand */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
        <div>
          <IntakeLabel>Language</IntakeLabel>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50"
          >
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </div>
        <div>
          <IntakeLabel>Voice</IntakeLabel>
          <select
            value={voice}
            onChange={(e) => setVoice(e.target.value as SpeakerVoice)}
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50"
          >
            {speakersForLang.map((s) => (
              <option key={s.id} value={s.id}>{s.label} · {s.description}</option>
            ))}
          </select>
        </div>
        <div>
          <IntakeLabel>Captions</IntakeLabel>
          <select
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50"
          >
            {CAPTION_STYLES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <IntakeLabel>Brand name</IntakeLabel>
          <input
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Your brand (optional)"
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
          />
        </div>
      </div>

      {/* Audio & Realism (feature toggles) — only renders rows the mode supports */}
      {(features.lipSync || features.music || features.cast) && (
        <div>
          <IntakeLabel><span className="text-[#14C8CC]">★</span> Audio & Realism · NEW</IntakeLabel>
          <div className="grid gap-3">
            {features.lipSync && (
              <FeatureToggle
                icon={<AudioLines className="w-4 h-4" />}
                title="Lip Sync"
                subtitle="Align character mouth shapes to the narration line by line."
                cost={COST_TABLE.lipSync}
                on={lipSync}
                onToggle={setLipSync}
              >
                <IntakeLabel>Lip sync strength</IntakeLabel>
                <IntakeSlider
                  value={lipStrength}
                  onChange={setLipStrength}
                  fmt={(v) => v < 40 ? 'Subtle' : v < 70 ? 'Natural' : 'Exaggerated'}
                />
              </FeatureToggle>
            )}

            {features.music && (
              <FeatureToggle
                icon={<Music className="w-4 h-4" />}
                title="Music & Sound Effects"
                subtitle="Auto-scored soundtrack plus optional ambient SFX and foley."
                cost={COST_TABLE.music}
                on={music}
                onToggle={setMusic}
              >
                <div className="grid gap-3.5">
                  <div>
                    <IntakeLabel>Music genre</IntakeLabel>
                    <div className="flex gap-1.5 flex-wrap">
                      {MUSIC_GENRES.map((g) => (
                        <Pill key={g} on={g === musicGenre} onClick={() => setMusicGenre(g)}>{g}</Pill>
                      ))}
                    </div>
                  </div>
                  <div>
                    <IntakeLabel>Intensity · auto-ducks under voice</IntakeLabel>
                    <IntakeSlider
                      value={musicIntensity}
                      onChange={setMusicIntensity}
                      fmt={(v) => v < 35 ? 'Bed' : v < 65 ? 'Balanced' : 'Driving'}
                    />
                  </div>
                  {features.sfx && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={sfx}
                        onClick={() => setSfx(!sfx)}
                        className={
                          'relative w-9 h-5 rounded-full transition-colors shrink-0 border ' +
                          (sfx ? 'bg-[#14C8CC] border-transparent' : 'bg-[#1B2228] border-white/10')
                        }
                      >
                        <span
                          className={
                            'absolute top-[1px] w-4 h-4 rounded-full transition-all ' +
                            (sfx ? 'left-[18px] bg-[#0A0D0F]' : 'left-[1px] bg-[#8A9198]')
                          }
                        />
                      </button>
                      <div className="text-[12.5px] text-[#ECEAE4]">Add ambient SFX & foley</div>
                      <span className="ml-auto font-mono text-[9px] text-[#5A6268] tracking-wider uppercase">+{COST_TABLE.sfx} cr</span>
                    </div>
                  )}
                </div>
              </FeatureToggle>
            )}

            {features.cast && (
              <FeatureToggle
                icon={<Users className="w-4 h-4" />}
                title="Character Consistency"
                subtitle="Lock character appearance across every scene."
                cost={COST_TABLE.cast}
                on={consistency}
                onToggle={setConsistency}
              >
                <IntakeLabel>Cast · pin up to 3 characters</IntakeLabel>
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => {
                    const m = cast[i];
                    return m ? (
                      <div key={i} className="flex items-center gap-2 p-2 rounded-lg border border-white/5 bg-[#1B2228]">
                        <div className="w-7 h-7 rounded-full grid place-items-center bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] font-serif font-semibold text-[12px]">
                          {m.initial}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] text-[#ECEAE4] truncate">{m.name}</div>
                          <div className="font-mono text-[9px] text-[#5A6268] tracking-wider uppercase">{m.role}</div>
                        </div>
                        {m.locked && <span className="text-[#14C8CC] text-[10px]">🔒</span>}
                      </div>
                    ) : (
                      <button
                        key={i}
                        type="button"
                        onClick={() => {
                          setCast((c) => [...c, { initial: 'C', name: `Character ${c.length + 1}`, role: c.length === 0 ? 'Narrator' : 'Supporting', locked: true }]);
                        }}
                        className="flex flex-col items-center gap-1 p-2 rounded-lg border border-dashed border-white/10 text-[#5A6268] hover:text-[#ECEAE4] hover:border-white/20 transition-colors"
                      >
                        <span className="text-[16px] leading-none">+</span>
                        <span className="text-[11px]">Add cast</span>
                      </button>
                    );
                  })}
                </div>
              </FeatureToggle>
            )}
          </div>
        </div>
      )}

      {/* Character appearance button */}
      {features.characterAppearance && (
        <div>
          <textarea
            value={characterAppearance}
            onChange={(e) => setCharacterAppearance(e.target.value)}
            placeholder="Describe your narrator / main character — face, wardrobe, age, vibe. Optional."
            rows={2}
            className="w-full bg-[#151B20] border border-white/5 rounded-xl px-4 py-3 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268] resize-y"
          />
        </div>
      )}

      {/* Visual style */}
      <div>
        <IntakeLabel>Visual style</IntakeLabel>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2 sm:gap-2.5">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStyleId(s.id)}
              className={
                'rounded-lg overflow-hidden text-[#ECEAE4] transition-all ' +
                (s.id === styleId
                  ? 'border-2 border-[#14C8CC] shadow-[0_0_0_4px_rgba(20,200,204,0.12)]'
                  : 'border border-white/5 hover:border-white/15')
              }
            >
              <div className="aspect-[4/3]" style={{ background: s.bg }} />
              <div className="py-1.5 px-1 text-[11px] font-medium truncate bg-[#10151A]">{s.name}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Direction: Tone / Camera / Grade */}
      <div>
        <IntakeLabel>Direction</IntakeLabel>
        <div className="grid gap-3">
          <IntakeField>
            <div className="flex items-center gap-3 mb-2">
              <div className="text-[12.5px] font-medium text-[#ECEAE4]">Tone & pacing</div>
              <div className="font-mono text-[10px] text-[#5A6268] tracking-wider">
                {tone < 25 ? 'CALM' : tone < 55 ? 'MEASURED' : tone < 80 ? 'ENERGETIC' : 'FRENETIC'}
              </div>
            </div>
            <IntakeSlider value={tone} onChange={setTone} fmt={(v) => `${v}%`} />
          </IntakeField>

          {features.camera && (
            <IntakeField>
              <div className="text-[12.5px] font-medium text-[#ECEAE4] mb-2.5 flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5" /> Camera movement
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CAMERA_MOTIONS.map((c) => (
                  <Pill key={c} on={c === camera} onClick={() => setCamera(c)}>{c}</Pill>
                ))}
              </div>
            </IntakeField>
          )}

          {features.colorGrade && (
            <IntakeField>
              <div className="text-[12.5px] font-medium text-[#ECEAE4] mb-2.5 flex items-center gap-1.5">
                <Palette className="w-3.5 h-3.5" /> Color grade
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_GRADES.map((g) => (
                  <Pill key={g} on={g === grade} onClick={() => setGrade(g)}>{g}</Pill>
                ))}
              </div>
            </IntakeField>
          )}
        </div>
      </div>

      {/* Mobile Generate button — desktop uses the rail, mobile sees it
          here too so users don't have to open the bottom sheet. */}
      <button
        type="submit"
        disabled={generating}
        className="lg:hidden w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[14px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] disabled:opacity-60"
      >
        {generating ? 'Submitting…' : `Create Video · ${totalCost} cr`}
      </button>
    </form>
  );
}
