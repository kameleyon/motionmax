import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  AudioLines, Music, Sparkles, Camera, Palette, Link as LinkIcon, Paperclip,
  ChevronLeft, ChevronRight, ImagePlus, X, Upload, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { isFlagOn } from '@/lib/featureFlags';
import {
  getDefaultSpeaker,
  getSpeakersForLanguage,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';
import {
  CaptionStyleSelector,
  type CaptionStyle,
} from '@/components/workspace/CaptionStyleSelector';
import { uploadStyleReference } from '@/lib/uploadStyleReference';
import { processAttachments } from '@/lib/attachmentProcessor';
import type { SourceAttachment } from '@/components/workspace/SourceInput';
import {
  FEATURES, MODE_LABEL, BASE_COST, ADDON_COST,
  type ProjectMode, type IntakeAspect, type IntakeDuration,
  type MusicGenre, type CameraMotion, type ColorGrade,
  type IntakeSettings,
} from './types';
import { IntakeField, IntakeLabel, IntakeSlider, Pill } from './primitives';
import FeatureToggle from './FeatureToggle';
import IntakeRail from './IntakeRail';
import { useIntakeRail } from './IntakeFrame';
import { PLAN_LIMITS, normalizePlanName } from '@/lib/planLimits';

// ── Real style preview thumbnails (same source as StyleSelector) ──
import minimalistPreview from '@/assets/styles/minimalist-preview.png';
import doodlePreview from '@/assets/styles/doodle-preview.png';
import stickPreview from '@/assets/styles/stick-preview.png';
import animePreview from '@/assets/styles/anime-preview.png';
import realisticPreview from '@/assets/styles/realistic-preview.png';
import pixarPreview from '@/assets/styles/3d-pixar-preview.png';
import claymationPreview from '@/assets/styles/claymation-preview.png';
import sketchPreview from '@/assets/styles/sketch-preview.png';
import caricaturePreview from '@/assets/styles/caricature-preview.png';
import storybookPreview from '@/assets/styles/painterly-preview.png';
import customPreview from '@/assets/styles/custom-preview.png';
import crayonPreview from '@/assets/styles/crayon-preview.png';
import moodyPreview from '@/assets/styles/moody-preview.png';
import chalkboardPreview from '@/assets/styles/chalkboard-preview.png';
import legoPreview from '@/assets/styles/lego-preview.png';
import cardboardPreview from '@/assets/styles/cardboard-preview.png';
import babiePreview from '@/assets/styles/barbie-preview.png';

const STYLES: Array<{ id: string; label: string; preview: string }> = [
  { id: 'realistic',  label: 'Realistic',   preview: realisticPreview },
  { id: '3d-pixar',   label: '3D Style',    preview: pixarPreview },
  { id: 'anime',      label: 'Anime',       preview: animePreview },
  { id: 'claymation', label: 'Claymation',  preview: claymationPreview },
  { id: 'storybook',  label: 'Storybook',   preview: storybookPreview },
  { id: 'caricature', label: 'Caricature',  preview: caricaturePreview },
  { id: 'doodle',     label: 'Urban Doodle',preview: doodlePreview },
  { id: 'stick',      label: 'Stick Figure',preview: stickPreview },
  { id: 'sketch',     label: 'Papercut 3D', preview: sketchPreview },
  { id: 'crayon',     label: 'Crayon',      preview: crayonPreview },
  { id: 'minimalist', label: 'Minimalist',  preview: minimalistPreview },
  { id: 'moody',      label: 'Moody',       preview: moodyPreview },
  { id: 'chalkboard', label: 'Chalkboard',  preview: chalkboardPreview },
  { id: 'lego',       label: 'LEGO',        preview: legoPreview },
  { id: 'cardboard',  label: 'Cardboard',   preview: cardboardPreview },
  { id: 'babie',      label: 'Babie',       preview: babiePreview },
  { id: 'custom',     label: 'Custom',      preview: customPreview },
];

// Full language catalogue — mirrors src/components/workspace/LanguageSelector.tsx
const LANGUAGES: Array<{ code: string; label: string; flag: string }> = [
  { code: 'en', label: 'English',         flag: '\u{1F1FA}\u{1F1F8}' },
  { code: 'fr', label: 'Français',        flag: '\u{1F1EB}\u{1F1F7}' },
  { code: 'es', label: 'Español',         flag: '\u{1F1EA}\u{1F1F8}' },
  { code: 'ht', label: 'Kreyòl Ayisyen',  flag: '\u{1F1ED}\u{1F1F9}' },
  { code: 'de', label: 'Deutsch',         flag: '\u{1F1E9}\u{1F1EA}' },
  { code: 'it', label: 'Italiano',        flag: '\u{1F1EE}\u{1F1F9}' },
  { code: 'nl', label: 'Nederlands',      flag: '\u{1F1F3}\u{1F1F1}' },
  { code: 'ru', label: 'Русский',         flag: '\u{1F1F7}\u{1F1FA}' },
  { code: 'zh', label: '中文',            flag: '\u{1F1E8}\u{1F1F3}' },
  { code: 'ja', label: '日本語',          flag: '\u{1F1EF}\u{1F1F5}' },
  { code: 'ko', label: '한국어',          flag: '\u{1F1F0}\u{1F1F7}' },
];

const MUSIC_GENRES: MusicGenre[] = ['Cinematic', 'Electronic', 'Acoustic', 'Ambient', 'Hip-hop', 'Jazz', 'Orchestral'];
const CAMERA_MOTIONS: CameraMotion[] = ['Static', 'Dolly', 'Handheld', 'Drone', 'Crane', 'Whip Pan'];
const COLOR_GRADES: ColorGrade[] = ['Kodak 250D', 'Bleach Bypass', 'Teal & Orange', 'Warm Film', 'Cool Noir', 'Desaturated'];

// Default format = portrait (9:16) per product call.
function aspectFromFormat(f: string): IntakeAspect {
  return f === 'landscape' ? '16:9' : '9:16';
}
function formatFromAspect(a: IntakeAspect): string {
  return a === '9:16' ? 'portrait' : 'landscape';
}

const MAX_CHAR_IMAGES = 3;
const MAX_CHAR_IMAGE_BYTES = 5 * 1024 * 1024;
// Character limits — enforced in the UI so users see the ceiling
// before they submit. The prompt cap matches buildDoc2Video /
// buildCinematic's server-side truncation at 15_000 chars. The
// character-description cap is tighter because that string is
// injected into EVERY scene's image prompt (15+ injections per run),
// so a long description balloons the LLM payload fast.
const MAX_PROMPT_CHARS = 15_000;
const MAX_CHAR_DESC_CHARS = 2000;

export default function IntakeForm({
  mode,
  initialPrompt = '',
  initialLanguage = 'en',
  initialFormat = 'portrait',
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

  const [prompt, setPrompt] = useState(initialPrompt);
  // Source attachments for the prompt — Add source / File / URL
  // buttons populate this, processAttachments() concatenates them
  // to the prompt text on submit so the worker sees the full source
  // material. Same SourceAttachment shape the legacy workspaces use.
  const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [aspect, setAspect] = useState<IntakeAspect>(aspectFromFormat(initialFormat));
  const [duration, setDuration] = useState<IntakeDuration>('<3min');
  const [language, setLanguage] = useState(initialLanguage);
  const [voice, setVoice] = useState<SpeakerVoice>(
    (initialVoice as SpeakerVoice) || getDefaultSpeaker(initialLanguage),
  );
  const [caption, setCaption] = useState<CaptionStyle>('cleanPop');
  const [brand, setBrand] = useState('');

  const [styleId, setStyleId] = useState('realistic');
  const [customStyle, setCustomStyle] = useState('');
  const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
  const [uploadingStyle, setUploadingStyle] = useState(false);

  const [tone, setTone] = useState(45);
  const [camera, setCamera] = useState<CameraMotion>('Dolly');
  const [grade, setGrade] = useState<ColorGrade>('Kodak 250D');

  const [lipSync, setLipSync] = useState(false);
  const [lipStrength, setLipStrength] = useState(70);
  const [music, setMusic] = useState(false);
  const [musicGenre, setMusicGenre] = useState<MusicGenre>('Cinematic');
  const [musicIntensity, setMusicIntensity] = useState(55);
  const [sfx, setSfx] = useState(false);

  // Character consistency is FORCED ON when the mode supports it — the
  // base credit cost already covers it, so it's not a toggle.
  const consistency = features.cast;
  const [characterDescription, setCharacterDescription] = useState('');
  const [characterImages, setCharacterImages] = useState<string[]>([]);
  // Separate from `sourceAttachments` — these apply only to the
  // character-consistency block (additional text/link references that
  // describe the lead's look).
  const [characterAttachments, setCharacterAttachments] = useState<SourceAttachment[]>([]);
  const charAttachmentInput = useRef<HTMLInputElement>(null);
  const charImageInput = useRef<HTMLInputElement>(null);

  const [generating, setGenerating] = useState(false);

  // ── Style carousel scroll controls ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const check = () => {
      setCanLeft(el.scrollLeft > 0);
      setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
    };
    check();
    el.addEventListener('scroll', check);
    return () => el.removeEventListener('scroll', check);
  }, []);
  const scrollBy = (dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'left' ? -240 : 240, behavior: 'smooth' });
  };

  const speakersForLang = useMemo(() => getSpeakersForLanguage(language), [language]);
  useEffect(() => {
    if (!speakersForLang.some((s) => s.id === voice)) setVoice(getDefaultSpeaker(language));
  }, [language, speakersForLang, voice]);

  const { data: credits } = useQuery({
    queryKey: ['intake-credits', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('user_credits').select('credits_balance').eq('user_id', user!.id).maybeSingle();
      return data;
    },
  });

  // Plan subscription lookup → drives the credits-cap number in the
  // rail. Uses the shared PLAN_LIMITS table so this number matches the
  // dashboard + billing page exactly.
  const { data: subscription } = useQuery({
    queryKey: ['intake-subscription', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('subscriptions')
        .select('plan_name, status')
        .eq('user_id', user!.id)
        .eq('status', 'active')
        .maybeSingle();
      return data;
    },
  });
  const plan = normalizePlanName(subscription?.plan_name ?? 'free');
  const creditsCap = PLAN_LIMITS[plan].creditsPerMonth || 1;

  const costItems = useMemo(() => {
    const items: Array<{ label: string; v: number }> = [
      { label: `Base · ${MODE_LABEL[mode]}`, v: BASE_COST[mode] },
    ];
    if (features.duration && duration === '>3min') items.push({ label: 'Duration · > 3 min', v: ADDON_COST.durationLong });
    if (features.lipSync && lipSync) items.push({ label: 'Lip sync', v: ADDON_COST.lipSync });
    // Music + SFX cost lines disabled while Lyria is unreliable.
    // if (features.music && music) items.push({ label: `Music · ${musicGenre}`, v: ADDON_COST.music });
    // if (features.sfx && music && sfx) items.push({ label: 'SFX & foley', v: ADDON_COST.sfx });
    return items;
  }, [mode, features, duration, lipSync, music, musicGenre, sfx]);

  const totalCost = costItems.reduce((a, x) => a + x.v, 0);

  const handleCharImageUpload = (files: FileList | null) => {
    if (!files) return;
    const remaining = MAX_CHAR_IMAGES - characterImages.length;
    if (remaining <= 0) { toast.error(`Max ${MAX_CHAR_IMAGES} reference images`); return; }
    const toProcess = Array.from(files).slice(0, remaining);
    const added: string[] = [];
    let processed = 0;
    for (const file of toProcess) {
      if (!file.type.startsWith('image/')) { toast.error(`${file.name} is not an image`); processed++; continue; }
      if (file.size > MAX_CHAR_IMAGE_BYTES) { toast.error(`${file.name} exceeds 5 MB`); processed++; continue; }
      const reader = new FileReader();
      reader.onload = () => {
        added.push(reader.result as string);
        processed++;
        if (processed === toProcess.length) setCharacterImages((prev) => [...prev, ...added]);
      };
      reader.readAsDataURL(file);
    }
  };

  /** Attach an arbitrary file to the Sources list. Handles image
   *  (blob URL), text (inline contents), other (type placeholder) —
   *  same logic as the File button's onChange, extracted so the
   *  paste + drop handlers can reuse it. */
  const attachFileToSources = async (file: File) => {
    const isImage = file.type.startsWith('image/');
    const isText = !isImage && /text|json|xml|csv|rtf|html/i.test(file.type || '');
    let value = '';
    if (isImage) value = URL.createObjectURL(file);
    else if (isText) { try { value = await file.text(); } catch { value = ''; } }
    else value = 'data:' + (file.type || 'application/octet-stream');
    setSourceAttachments((prev) => [...prev, {
      id: `${Date.now()}-${file.name}`,
      type: isImage ? 'image' : 'file',
      name: file.name,
      value,
    }]);
  };

  /** Turn a pasted URL string into a typed source chip. Returns true
   *  if a URL was detected + attached, false otherwise (so the caller
   *  can let the default paste behaviour insert the text into the
   *  textarea). */
  const tryAttachUrl = (raw: string, target: 'sources' | 'character'): boolean => {
    const url = raw.trim();
    if (!/^https?:\/\//i.test(url)) return false;
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      const kind: SourceAttachment['type'] =
        host.includes('youtube.com') || host === 'youtu.be' ? 'youtube'
        : host.includes('github.com') ? 'github'
        : host.includes('drive.google.com') ? 'gdrive'
        : 'link';
      if (target === 'sources') {
        setSourceAttachments((prev) => [...prev, {
          id: `${Date.now()}-url`, type: kind, name: u.host, value: url,
        }]);
        toast.success(`${kind === 'link' ? 'URL' : kind === 'youtube' ? 'YouTube link' : kind === 'github' ? 'GitHub repo' : 'Drive link'} attached.`);
      } else {
        setCharacterAttachments((prev) => [...prev, {
          id: `${Date.now()}-url`, type: kind, name: u.host, value: url,
        }]);
        toast.success('Reference link attached.');
      }
      return true;
    } catch {
      return false;
    }
  };

  /** Paste handler used by both textareas. Images on the clipboard
   *  get attached as references; URL-only paste becomes a chip; plain
   *  text falls through to the default behaviour. */
  const handlePasteForSources = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Images first
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItem) {
      const f = imageItem.getAsFile();
      if (f) { e.preventDefault(); void attachFileToSources(f); toast.success('Pasted image attached.'); return; }
    }
    // URL-only paste → chip
    const text = e.clipboardData?.getData('text') ?? '';
    if (text && /^https?:\/\/\S+$/.test(text.trim())) {
      if (tryAttachUrl(text, 'sources')) { e.preventDefault(); return; }
    }
    // else: default textarea paste
  };

  const handlePasteForCharacter = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItem) {
      // Pasted images go into the reference-image grid (same path as
      // the file picker).
      const f = imageItem.getAsFile();
      if (f) {
        e.preventDefault();
        const dt = new DataTransfer();
        dt.items.add(f);
        handleCharImageUpload(dt.files);
        return;
      }
    }
    const text = e.clipboardData?.getData('text') ?? '';
    if (text && /^https?:\/\/\S+$/.test(text.trim())) {
      if (tryAttachUrl(text, 'character')) { e.preventDefault(); return; }
    }
  };

  /** Drop handler for the Sources textarea. Image files → attach;
   *  other files → attach. */
  const handleDropForSources = async (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) await attachFileToSources(f);
    toast.success(`${files.length} source${files.length === 1 ? '' : 's'} attached.`);
  };

  const handleDropForCharacter = (e: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    const dt = new DataTransfer();
    for (const f of files) if (f.type.startsWith('image/')) dt.items.add(f);
    if (dt.files.length > 0) handleCharImageUpload(dt.files);
  };

  const handleCustomStyleImageUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image'); return; }
    if (file.size > MAX_CHAR_IMAGE_BYTES) { toast.error('Max 5 MB'); return; }
    setUploadingStyle(true);
    try {
      const url = await uploadStyleReference(file);
      setCustomStyleImage(url);
    } catch {
      toast.error('Upload failed — try a different image');
    } finally {
      setUploadingStyle(false);
    }
  };

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
        // ── MUSIC + SFX TEMPORARILY DISABLED ──
        // Lyria generation is not reliable yet (Hypereal + Google
        // direct both had issues). Leaving the toggle state here but
        // forcing `music.on` false so no Lyria call fires downstream.
        // Re-enable by restoring this spread once Lyria is stable:
        //   ...(features.music && music ? {
        //     music: { on: true, genre: musicGenre, intensity: musicIntensity, sfx: features.sfx && sfx },
        //   } : {}),
        ...(features.characterAppearance && characterDescription ? { characterAppearance: characterDescription } : {}),
        captionStyle: caption,
        ...(brand.trim() ? { brandName: brand.trim() } : {}),
      };

      const title = prompt.trim().slice(0, 80);
      const length = features.duration && duration === '>3min' ? 'presentation' : 'short';

      // Read + concat attached sources BEFORE the project row is
      // inserted — processAttachments inlines text files, uploads
      // images to Supabase storage, and tags links / youtube / github
      // / gdrive URLs with [FETCH_URL] / [YOUTUBE_URL] / [GITHUB_URL]
      // etc. so the worker knows to fetch them during script gen.
      // The worker's buildSmartFlow / buildDoc2Video / buildCinematic
      // prompts include the full content block as the user's input,
      // so these sections land directly in the LLM prompt.
      let enrichedContent = prompt.trim();
      try {
        const attached = await processAttachments(sourceAttachments);
        if (attached) enrichedContent += attached;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Couldn't attach sources: ${msg}`);
        return;
      }

      // Append character-block text/link references to the description
      // so the LLM sees them alongside the user's typed description.
      // Kept defensive: if the combined description would exceed the
      // per-scene cap, truncate with a note. processAttachments is
      // reused for the link-typed chips (YouTube/URL/etc.) so they
      // get the same [FETCH_URL] / [YOUTUBE_URL] tagging as Sources.
      let enrichedCharDesc = characterDescription.trim();
      if (characterAttachments.length > 0) {
        try {
          const attachedChar = await processAttachments(characterAttachments);
          if (attachedChar) enrichedCharDesc = (enrichedCharDesc + attachedChar).trim();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Couldn't attach character references: ${msg}`);
          return;
        }
        if (enrichedCharDesc.length > MAX_CHAR_DESC_CHARS) {
          enrichedCharDesc = enrichedCharDesc.slice(0, MAX_CHAR_DESC_CHARS - 30) + "\n[character notes truncated]";
        }
      }

      // characterImages was previously DROPPED on insert — the
      // workspace had to re-attach them on first load. Worker
      // generateVideo.ts:119 reads payload.characterImages from the
      // job; the kickoff includes them, but the project row didn't,
      // so any flow that re-loaded the project (refresh, share) lost
      // the references entirely. Now they ride along on the row.
      const projectInsert: Record<string, unknown> = {
        user_id: user.id,
        title,
        content: enrichedContent,
        project_type: mode,
        format: formatFromAspect(aspect),
        length,
        voice_name: voice,
        voice_inclination: language,
        style: styleId,
        character_description: enrichedCharDesc || null,
        character_consistency_enabled: consistency,
        character_images: characterImages.length > 0 ? characterImages : null,
        intake_settings: intakeSettings,
      };

      let insertResult = await supabase.from('projects').insert(projectInsert as never).select('id').single();
      // Defensive fallback — if intake_settings column is missing in
      // prod (migration 20260422010000 not applied), STORE the settings
      // inside the project's `content` field as a JSON suffix so the
      // worker can still recover them. Previous behaviour silently
      // dropped the settings, which meant music/sfx/captions/lipsync
      // toggles never reached handleFinalize and features appeared
      // completely broken even when fully wired. The suffix is a
      // sentinel-delimited JSON blob that buildSmartFlow/Cinematic
      // preprocess strips before the LLM sees it.
      if (insertResult.error && insertResult.error.message?.toLowerCase().includes('intake_settings')) {
        const { intake_settings: _drop, ...withoutIntake } = projectInsert;
        void _drop;
        const contentWithIntake =
          (withoutIntake as { content: string }).content +
          `\n\n<!--INTAKE_SETTINGS:${JSON.stringify(intakeSettings)}:END-->\n`;
        insertResult = await supabase
          .from('projects')
          .insert({ ...withoutIntake, content: contentWithIntake } as never)
          .select('id')
          .single();
        console.warn(
          '[IntakeForm] intake_settings column missing — persisted to content suffix as fallback',
        );
      }
      const { data, error } = insertResult;
      if (error || !data) throw error || new Error('Insert returned no row');

      toast.success('Project created. Taking you to the editor…');
      // Route to the new unified Editor when the flag is on, else fall
      // back to the legacy workspace flow so we don't lose users mid-
      // rollout. See player_editor_roadmap.md Phase 0.
      const editorRoute = isFlagOn('UNIFIED_EDITOR')
        ? `/app/editor/${data.id}?autostart=1`
        : `/app/create?project=${data.id}&autostart=1`;
      navigate(editorRoute);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save project: ${msg}`);
    } finally {
      setGenerating(false);
    }
  }

  // Bridge cost + rail content into IntakeFrame.
  const rail = useIntakeRail();
  useEffect(() => {
    rail.setTotalCost(totalCost);
    rail.setRailContent(
      <IntakeRail
        aspect={aspect}
        prompt={prompt}
        mode={mode}
        visualStyle={{ name: STYLES.find((s) => s.id === styleId)?.label ?? 'Style' }}
        language={language}
        voice={voice}
        captionStyle={caption}
        duration={features.duration ? duration : undefined}
        consistency={consistency}
        characterDescriptionLen={characterDescription.trim().length}
        music={music}
        lipSync={lipSync}
        styleId={styleId}
        costItems={costItems}
        totalCost={totalCost}
        creditsAvailable={credits?.credits_balance ?? 0}
        creditsCap={creditsCap}
        onGenerate={handleGenerate}
        generating={generating}
      />,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect, prompt, mode, styleId, language, voice, caption, duration, consistency, characterDescription, music, lipSync, features, costItems, totalCost, credits, creditsCap, generating]);

  const selectedStyle = STYLES.find((s) => s.id === styleId);

  return (
    <form onSubmit={(e) => { e.preventDefault(); handleGenerate(); }} className="flex flex-col gap-6 sm:gap-7">
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
            onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT_CHARS))}
            onPaste={handlePasteForSources}
            onDrop={handleDropForSources}
            onDragOver={(e) => e.preventDefault()}
            rows={4}
            maxLength={MAX_PROMPT_CHARS}
            placeholder="Describe your video idea, paste text, drop images, or add sources with +"
            className="w-full min-h-[100px] bg-transparent border-0 outline-none text-[#ECEAE4] font-serif text-[15px] sm:text-[16px] leading-[1.5] resize-y p-4"
          />
          <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-t border-white/5">
            {/* Hidden file input — the visible File button triggers it.
                Accepts text / markdown / pdf / images. Non-text files
                are passed to processAttachments() which handles them
                per-type at submit (images → Supabase storage upload,
                text files → inline content). */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.csv,.json,.rtf,.html,.pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length === 0) return;
                (async () => {
                  const added: SourceAttachment[] = [];
                  for (const f of files) {
                    const isImage = f.type.startsWith('image/');
                    const isText = !isImage && /text|json|xml|csv|rtf|html/i.test(f.type || '');
                    let value = '';
                    if (isImage) {
                      // Stash a blob: URL; processAttachments uploads
                      // to Supabase storage at submit time.
                      value = URL.createObjectURL(f);
                    } else if (isText) {
                      try {
                        value = await f.text();
                      } catch {
                        value = '';
                      }
                    } else {
                      value = 'data:' + (f.type || 'application/octet-stream');
                    }
                    added.push({
                      id: `${Date.now()}-${f.name}`,
                      type: isImage ? 'image' : 'file',
                      name: f.name,
                      value,
                    });
                  }
                  setSourceAttachments((prev) => [...prev, ...added]);
                  toast.success(`${added.length} source${added.length === 1 ? '' : 's'} attached.`);
                })();
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => {
                // "Add source" shows the file picker — same flow as
                // the File button. Kept as a separate affordance
                // because the visual treatment (dashed border) signals
                // "primary add action" vs the specific-type buttons.
                fileInputRef.current?.click();
              }}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-dashed border-white/10 rounded-md hover:text-[#ECEAE4]"
            >
              + Add source
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
            >
              <Paperclip className="w-3 h-3" /> File
            </button>
            <button
              type="button"
              onClick={() => {
                const raw = window.prompt('Paste a URL, YouTube link, or GitHub repo link:');
                const url = raw?.trim();
                if (!url) return;
                try {
                  const u = new URL(url);
                  const host = u.host.toLowerCase();
                  const kind: SourceAttachment['type'] =
                    host.includes('youtube.com') || host === 'youtu.be' ? 'youtube'
                    : host.includes('github.com') ? 'github'
                    : host.includes('drive.google.com') ? 'gdrive'
                    : 'link';
                  setSourceAttachments((prev) => [
                    ...prev,
                    { id: `${Date.now()}-url`, type: kind, name: u.host, value: url },
                  ]);
                  toast.success(`${kind === 'link' ? 'URL' : kind === 'youtube' ? 'YouTube link' : kind === 'github' ? 'GitHub repo' : 'Drive link'} attached.`);
                } catch {
                  toast.error('That doesn\'t look like a valid URL.');
                }
              }}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
            >
              <LinkIcon className="w-3 h-3" /> URL
            </button>
            <div className="flex-1" />
            {/* Character counter. Colors lean to gold/red as the user
                approaches the MAX so it's obvious before submit. */}
            <span
              className={cn(
                'font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-1',
                prompt.length > MAX_PROMPT_CHARS * 0.9
                  ? 'text-[#E4C875]'
                  : 'text-[#5A6268]',
              )}
              aria-label={`${prompt.length} of ${MAX_PROMPT_CHARS} characters used`}
            >
              {prompt.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
            </span>
            <button
              type="button"
              onClick={() => toast.info('Smart Prompt coming soon.')}
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#14C8CC] px-2 py-1 border border-[#14C8CC]/30 rounded-md bg-[#14C8CC]/10 hover:bg-[#14C8CC]/20"
            >
              <Sparkles className="w-3 h-3" /> Smart prompt
            </button>
          </div>
          {/* Attached-sources chip list. Remove per-item with the ×. */}
          {sourceAttachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
              {sourceAttachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#ECEAE4] px-2 py-0.5 rounded-md bg-[#1B2228] border border-white/10"
                  title={`${a.type} · ${a.name}`}
                >
                  <span className="uppercase text-[#14C8CC]">{a.type}</span>
                  <span className="truncate max-w-[180px]">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setSourceAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    aria-label={`Remove ${a.name}`}
                    className="text-[#8A9198] hover:text-[#E4C875]"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </IntakeField>
      </div>

      {/* Format + Duration — compact pill groups, NOT full-width */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div>
          <IntakeLabel>Format</IntakeLabel>
          <div className="inline-flex rounded-lg border border-white/5 bg-[#151B20] p-1 gap-1">
            {(['16:9', '9:16'] as IntakeAspect[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAspect(a)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider transition-colors',
                  a === aspect
                    ? 'bg-[#14C8CC]/10 text-[#14C8CC]'
                    : 'text-[#8A9198] hover:text-[#ECEAE4]',
                )}
              >
                <div className="border-[1.5px] border-current rounded-[2px]" style={{ width: a === '16:9' ? 14 : 8, height: a === '16:9' ? 8 : 14 }} />
                {a}
              </button>
            ))}
          </div>
        </div>

        {features.duration && (
          <div>
            <IntakeLabel>Duration</IntakeLabel>
            <div className="inline-flex rounded-lg border border-white/5 bg-[#151B20] p-1 gap-1">
              {([['<3min', '< 3 min'], ['>3min', '> 3 min']] as Array<[IntakeDuration, string]>).map(([v, t]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDuration(v)}
                  className={cn(
                    'px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider transition-colors',
                    v === duration
                      ? 'bg-[#14C8CC]/10 text-[#14C8CC]'
                      : 'text-[#8A9198] hover:text-[#ECEAE4]',
                  )}
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
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
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
          <div className="bg-[#151B20] border border-white/5 rounded-lg px-2 py-1.5">
            <CaptionStyleSelector value={caption} onChange={setCaption} showLabel={false} />
          </div>
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

      {/* Audio & Realism — Music + SFX commented out while Lyria is
          unstable. Lip sync section kept but hidden unless standalone
          by dropping the `features.music` half of the gate. Uncomment
          the original block below to restore. */}
      {features.lipSync && (
        <div>
          <IntakeLabel><span className="text-[#14C8CC]">★</span> Audio & realism · NEW</IntakeLabel>
          <div className="grid gap-3">
            <FeatureToggle
              icon={<AudioLines className="w-4 h-4" />}
              title="Lip Sync"
              subtitle="Align character mouth shapes to the narration line by line."
              cost={ADDON_COST.lipSync}
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
          </div>
        </div>
      )}
      {/*
      ── ORIGINAL AUDIO & REALISM BLOCK (music + sfx disabled) ──
      {(features.lipSync || features.music) && (
        <div>
          <IntakeLabel><span className="text-[#14C8CC]">★</span> Audio & realism · NEW</IntakeLabel>
          <div className="grid gap-3">
            {features.lipSync && (
              <FeatureToggle
                icon={<AudioLines className="w-4 h-4" />}
                title="Lip Sync"
                subtitle="Align character mouth shapes to the narration line by line."
                cost={ADDON_COST.lipSync}
                on={lipSync}
                onToggle={setLipSync}
              >
                <IntakeLabel>Lip sync strength</IntakeLabel>
                <IntakeSlider value={lipStrength} onChange={setLipStrength} fmt={(v) => v < 40 ? 'Subtle' : v < 70 ? 'Natural' : 'Exaggerated'} />
              </FeatureToggle>
            )}
            {features.music && (
              <FeatureToggle
                icon={<Music className="w-4 h-4" />}
                title="Music & Sound Effects"
                subtitle="Auto-scored soundtrack plus optional ambient SFX and foley."
                cost={ADDON_COST.music}
                on={music}
                onToggle={setMusic}
              >
                <div className="grid gap-3.5">
                  <div>
                    <IntakeLabel>Music genre</IntakeLabel>
                    <div className="flex gap-1.5 flex-wrap">
                      {MUSIC_GENRES.map((g) => (<Pill key={g} on={g === musicGenre} onClick={() => setMusicGenre(g)}>{g}</Pill>))}
                    </div>
                  </div>
                  <div>
                    <IntakeLabel>Intensity · auto-ducks under voice</IntakeLabel>
                    <IntakeSlider value={musicIntensity} onChange={setMusicIntensity} fmt={(v) => v < 35 ? 'Bed' : v < 65 ? 'Balanced' : 'Driving'} />
                  </div>
                  {features.sfx && (
                    <div className="flex items-center gap-2">
                      <button type="button" role="switch" aria-checked={sfx} onClick={() => setSfx(!sfx)} className={cn('relative w-9 h-5 rounded-full transition-colors shrink-0 border', sfx ? 'bg-[#14C8CC] border-transparent' : 'bg-[#1B2228] border-white/10')}>
                        <span className={cn('absolute top-[1px] w-4 h-4 rounded-full transition-all', sfx ? 'left-[18px] bg-[#0A0D0F]' : 'left-[1px] bg-[#8A9198]')} />
                      </button>
                      <div className="text-[12.5px] text-[#ECEAE4]">Add ambient SFX & foley</div>
                      <span className="ml-auto font-mono text-[9px] text-[#5A6268] tracking-wider uppercase">+{ADDON_COST.sfx} cr</span>
                    </div>
                  )}
                </div>
              </FeatureToggle>
            )}
          </div>
        </div>
      )}
      */}

      {/* Character consistency — ALWAYS ON for cinematic + explainer (folded
          into base cost). Renders a read-only "on" pill + the char
          description + image-upload area that used to live in the Cast slot. */}
      {consistency && features.characterAppearance && (
        <div>
          {/* Single-line header: label + "Always on" pill stay on the same
              row at every breakpoint. Hand-rolled label classes so we can
              control mb + whitespace at the container level. */}
          <div className="flex items-center gap-2 mb-2 whitespace-nowrap">
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268]">
              Character consistency
            </span>
            <span className="inline-flex items-center font-mono text-[10px] tracking-[0.1em] uppercase text-[#14C8CC] px-2 py-0.5 rounded-md bg-[#14C8CC]/10 border border-[#14C8CC]/30 shrink-0">
              Always on
            </span>
          </div>

          <IntakeField className="p-3 sm:p-4">
            <p className="text-[12px] text-[#8A9198] mb-3 leading-[1.5]">
              Keep the same character across every scene. Describe your lead, and
              optionally drop in up to {MAX_CHAR_IMAGES} reference images so the
              model knows what they look like.
            </p>

            <textarea
              value={characterDescription}
              onChange={(e) => setCharacterDescription(e.target.value.slice(0, MAX_CHAR_DESC_CHARS))}
              onPaste={handlePasteForCharacter}
              onDrop={handleDropForCharacter}
              onDragOver={(e) => e.preventDefault()}
              rows={3}
              maxLength={MAX_CHAR_DESC_CHARS}
              placeholder="A 30-year-old man with short brown hair, warm brown eyes, a close-cropped beard, wearing a navy sweater. Earnest expression. Paste text, drop images, or attach reference links below."
              className="w-full bg-[#1B2228] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268] resize-y"
            />

            {/* Reference-image file input (kept — same 5 MB, image-only cap) */}
            <input
              ref={charImageInput}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => { handleCharImageUpload(e.target.files); e.target.value = ''; }}
              className="hidden"
            />

            {/* Generic attachment input — text / markdown / pdf /
                images. Mirrors the Sources section so users can attach
                non-image reference material (character notes, style
                guide snippets) directly to the character block. */}
            <input
              ref={charAttachmentInput}
              type="file"
              accept=".txt,.md,.csv,.json,.rtf,.html,.pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length === 0) return;
                (async () => {
                  const added: SourceAttachment[] = [];
                  for (const f of files) {
                    const isImage = f.type.startsWith('image/');
                    // Image files go into the reference grid, not the
                    // attachments list.
                    if (isImage) {
                      const dt = new DataTransfer();
                      dt.items.add(f);
                      handleCharImageUpload(dt.files);
                      continue;
                    }
                    const isText = /text|json|xml|csv|rtf|html/i.test(f.type || '');
                    let value = '';
                    if (isText) { try { value = await f.text(); } catch { value = ''; } }
                    else value = 'data:' + (f.type || 'application/octet-stream');
                    added.push({
                      id: `${Date.now()}-${f.name}`,
                      type: 'file',
                      name: f.name,
                      value,
                    });
                  }
                  if (added.length > 0) {
                    setCharacterAttachments((prev) => [...prev, ...added]);
                    toast.success(`${added.length} reference${added.length === 1 ? '' : 's'} attached.`);
                  }
                })();
                e.target.value = '';
              }}
            />

            {/* Button row — matches the Sources & Direction layout:
                + Add source / File / URL, with the char counter on the
                right. Same hover + border styling so users recognise
                the affordance immediately. */}
            <div className="flex items-center gap-2 flex-wrap mt-3 pt-2.5 border-t border-white/5">
              <button
                type="button"
                onClick={() => charAttachmentInput.current?.click()}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-dashed border-white/10 rounded-md hover:text-[#ECEAE4]"
              >
                + Add source
              </button>
              <button
                type="button"
                onClick={() => charAttachmentInput.current?.click()}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
              >
                <Paperclip className="w-3 h-3" /> File
              </button>
              <button
                type="button"
                onClick={() => {
                  const raw = window.prompt('Paste a URL to a character reference photo or profile:');
                  if (!raw) return;
                  if (!tryAttachUrl(raw, 'character')) {
                    toast.error("That doesn't look like a valid URL.");
                  }
                }}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.1em] uppercase text-[#8A9198] px-2 py-1 border border-white/5 rounded-md hover:text-[#ECEAE4]"
              >
                <LinkIcon className="w-3 h-3" /> URL
              </button>
              <div className="flex-1" />
              <span
                className={cn(
                  'font-mono text-[10px] tracking-[0.1em] uppercase px-2 py-1',
                  characterDescription.length > MAX_CHAR_DESC_CHARS * 0.9
                    ? 'text-[#E4C875]'
                    : 'text-[#5A6268]',
                )}
                aria-label={`${characterDescription.length} of ${MAX_CHAR_DESC_CHARS} characters used`}
              >
                {characterDescription.length} / {MAX_CHAR_DESC_CHARS}
              </span>
            </div>

            {/* Reference image grid (unchanged) */}
            <div className="mt-3 flex flex-wrap gap-2.5">
              {characterImages.map((src, i) => (
                <div key={i} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 bg-[#1B2228]">
                  <img src={src} alt={`Reference ${i + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setCharacterImages((p) => p.filter((_, j) => j !== i))}
                    className="absolute top-1 right-1 p-0.5 rounded-full bg-black/70 hover:bg-black text-white"
                    aria-label="Remove reference"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {characterImages.length < MAX_CHAR_IMAGES && (
                <button
                  type="button"
                  onClick={() => charImageInput.current?.click()}
                  className="w-16 h-16 rounded-lg border border-dashed border-white/10 hover:border-[#14C8CC]/40 hover:bg-[#14C8CC]/5 text-[#5A6268] hover:text-[#14C8CC] transition-colors flex flex-col items-center justify-center gap-0.5"
                >
                  <ImagePlus className="w-4 h-4" />
                  <span className="text-[9px] font-mono tracking-wider uppercase">Add</span>
                </button>
              )}
            </div>

            {/* Chip list for text / link references */}
            {characterAttachments.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                {characterAttachments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#ECEAE4] px-2 py-0.5 rounded-md bg-[#1B2228] border border-white/10"
                    title={`${a.type} · ${a.name}`}
                  >
                    <span className="uppercase text-[#14C8CC]">{a.type}</span>
                    <span className="truncate max-w-[180px]">{a.name}</span>
                    <button
                      type="button"
                      onClick={() => setCharacterAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      aria-label={`Remove ${a.name}`}
                      className="text-[#8A9198] hover:text-[#E4C875]"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </IntakeField>
        </div>
      )}

      {/* Visual style — real thumbnails, horizontal scroll */}
      <div>
        <IntakeLabel>Visual style</IntakeLabel>
        <div className="relative">
          <button
            type="button"
            onClick={() => scrollBy('left')}
            className={cn(
              'absolute left-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full grid place-items-center border border-white/10 bg-[#0A0D0F]/90 backdrop-blur-sm text-[#ECEAE4] hover:bg-[#151B20] transition-opacity',
              canLeft ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            aria-label="Scroll styles left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollBy('right')}
            className={cn(
              'absolute right-0 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full grid place-items-center border border-white/10 bg-[#0A0D0F]/90 backdrop-blur-sm text-[#ECEAE4] hover:bg-[#151B20] transition-opacity',
              canRight ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            aria-label="Scroll styles right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          <div
            ref={scrollRef}
            className="flex gap-2.5 overflow-x-auto scrollbar-hide px-1 py-1 snap-x snap-mandatory"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {STYLES.map((s) => (
              <motion.button
                key={s.id}
                type="button"
                onClick={() => setStyleId(s.id)}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  'snap-start shrink-0 w-[108px] sm:w-[128px] rounded-xl overflow-hidden text-[#ECEAE4] transition-all border-2',
                  s.id === styleId
                    ? 'border-[#14C8CC] shadow-[0_0_0_4px_rgba(20,200,204,0.12)]'
                    : 'border-white/5 hover:border-white/15',
                )}
              >
                <div className="aspect-[4/3] bg-[#1B2228]">
                  <img src={s.preview} alt={s.label} loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className={cn(
                  'py-1.5 px-1 text-center text-[11.5px] font-medium transition-colors',
                  s.id === styleId ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'bg-[#10151A] text-[#8A9198]',
                )}>
                  {s.label}
                </div>
              </motion.button>
            ))}
          </div>
        </div>

        {selectedStyle?.id === 'custom' && (
          <div className="mt-3 grid gap-2.5">
            <input
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              placeholder="Describe your custom visual style…"
              className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-[13px] text-[#ECEAE4] outline-none focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
            />
            {customStyleImage ? (
              <div className="relative inline-block">
                <img src={customStyleImage} alt="Style reference" className="h-24 rounded-lg border border-white/10" />
                <button
                  type="button"
                  onClick={() => setCustomStyleImage(null)}
                  className="absolute top-1 right-1 p-1 rounded-full bg-black/70 text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-white/10 text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20 cursor-pointer text-[12.5px] w-fit">
                {uploadingStyle ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {uploadingStyle ? 'Uploading…' : 'Upload reference image'}
                <input
                  type="file" accept="image/*" className="hidden"
                  onChange={(e) => handleCustomStyleImageUpload(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
          </div>
        )}
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

      {/* Mobile Generate button (desktop uses the rail CTA) */}
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
