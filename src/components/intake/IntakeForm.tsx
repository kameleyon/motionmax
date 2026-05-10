import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AudioLines, Wand2, Link as LinkIcon, Paperclip,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { trackEvent } from '@/hooks/useAnalytics';
import { EVENTS } from '@/lib/events';
import { isAutopostEligible, getAutopostCreditsRequired } from '@/lib/planLimits';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAdminAuth } from '@/hooks/useAdminAuth';
import { supabase } from '@/integrations/supabase/client';
import { useUserClones, resolveVoiceForProject } from "@/hooks/useUserClones";
import { INTERVAL_TO_CRON } from './_scheduleConstants';
import { nextFireFromCron } from '@/pages/lab/autopost/_utils';
import type { ScheduleState } from './ScheduleBlock';
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
  type MusicGenre, type CameraMotion, type ColorGrade, type SceneTransition,
  type IntakeSettings,
} from './types';
import { IntakeField, IntakeLabel, IntakeSlider } from './primitives';
import FeatureToggle from './FeatureToggle';
import IntakeRail from './IntakeRail';
import { useIntakeRail } from './IntakeFrame';
import { PLAN_LIMITS, normalizePlanName } from '@/lib/planLimits';
import StepLoadingSkeleton from './steps/StepLoadingSkeleton';
// styleLabelFor is in its own tiny module so importing it here doesn't
// pull the StyleCarousel chunk's STYLES URL handles into this bundle.
import { styleLabelFor } from './steps/styleLabels';

// C-5-7 (Prism PERF-011): three of the heaviest sections of this form
// are split into their own React.lazy chunks so the prompt textarea +
// format/duration controls + language/voice/captions/brand row paint
// before the rest of the form is parsed. Each lazy chunk loads under a
// <Suspense> with a sized skeleton so the layout doesn't jump.
//
//  * StyleCarousel              — 17 image-preview URL handles +
//                                  framer-motion + carousel scroll
//                                  controls. Was the single largest
//                                  contributor to the IntakeForm chunk.
//  * DirectionBlock             — Tone slider + camera/transition/grade
//                                  pill grids. Constant tables live in
//                                  the chunk.
//  * CharacterConsistencyBlock  — character textarea + image-upload
//                                  affordance + reference grid + chip
//                                  list. Only mounted when the mode
//                                  features supports it (cinematic +
//                                  explainer); other modes never load
//                                  this chunk.
const StyleCarousel = lazy(() => import('./steps/StyleCarousel'));
const DirectionBlock = lazy(() => import('./steps/DirectionBlock'));
const CharacterConsistencyBlock = lazy(() => import('./steps/CharacterConsistencyBlock'));

// ── Real style preview thumbnails ──
// C-5-7 (Prism PERF-011): the STYLES array, the carousel JSX, and its
// scroll-controls now live in src/components/intake/steps/StyleCarousel.tsx.
// The 17 webp/png URL handles + framer-motion + scroll ref logic ship
// in their own lazy chunk, so the IntakeForm chunk no longer has to
// parse them on first paint. `styleLabelFor()` is re-exported so the
// rail summary can resolve a styleId to its display label without
// dragging the entire array back into this chunk.

// §5 PERF-003 fix (2026-05-10): all 17 thumbs are now WebP. Re-encoded
// at q=80-82 with `ffmpeg -c:v libwebp` from the original PNGs in
// src/assets/styles/. Total weight on the wire dropped from ~3.6 MB
// (PNG) to ~570 KB (WebP) — an 84% reduction. The single worst
// offender, `cardboard-preview.png` at 1.84 MB, is now 93 KB.
// Regenerate any PNG → WebP with:
//   ffmpeg -y -i src/assets/styles/<name>.png -c:v libwebp \
//     -quality 80 -compression_level 6 -an src/assets/styles/<name>.webp

// Full language catalogue — mirrors src/components/workspace/LanguageSelector.tsx
// C-1-2: each row carries a BCP-47 `lang` code + an `englishName` so the
// <option> can self-tag with `lang` (switches screen-reader TTS voice)
// and carry an aria-label that announces the language in English for
// users whose AT stays on a single voice.
const LANGUAGES: Array<{ code: string; label: string; flag: string; englishName: string }> = [
  { code: 'en', label: 'English',         flag: '\u{1F1FA}\u{1F1F8}', englishName: 'English' },
  { code: 'fr', label: 'Français',        flag: '\u{1F1EB}\u{1F1F7}', englishName: 'French' },
  { code: 'es', label: 'Español',         flag: '\u{1F1EA}\u{1F1F8}', englishName: 'Spanish' },
  { code: 'ht', label: 'Kreyòl Ayisyen',  flag: '\u{1F1ED}\u{1F1F9}', englishName: 'Haitian Creole' },
  { code: 'de', label: 'Deutsch',         flag: '\u{1F1E9}\u{1F1EA}', englishName: 'German' },
  { code: 'it', label: 'Italiano',        flag: '\u{1F1EE}\u{1F1F9}', englishName: 'Italian' },
  { code: 'nl', label: 'Nederlands',      flag: '\u{1F1F3}\u{1F1F1}', englishName: 'Dutch' },
  { code: 'ru', label: 'Русский',         flag: '\u{1F1F7}\u{1F1FA}', englishName: 'Russian' },
  { code: 'zh', label: '中文',            flag: '\u{1F1E8}\u{1F1F3}', englishName: 'Chinese' },
  { code: 'ja', label: '日本語',          flag: '\u{1F1EF}\u{1F1F5}', englishName: 'Japanese' },
  { code: 'ko', label: '한국어',          flag: '\u{1F1F0}\u{1F1F7}', englishName: 'Korean' },
];

// MUSIC_GENRES removed alongside the Music + SFX intake UI block while
// Lyria is unstable. See git history for the constant + the JSX block
// when re-enabling.
//
// CAMERA_MOTIONS / SCENE_TRANSITIONS / COLOR_GRADES were moved into
// src/components/intake/steps/DirectionBlock.tsx alongside the JSX that
// renders them — see C-5-7 (Prism PERF-011) lazy-chunk split.

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
// Auto-attach thresholds — match the legacy workspace SourceInput
// behaviour. Pasted text longer than AUTO_ATTACH_THRESHOLD becomes a
// "text" chip (so the textarea stays clean and the raw paste is
// preserved verbatim for processAttachments to inline at submit);
// each chip caps at MAX_ATTACHMENT_CHARS total.
const AUTO_ATTACH_THRESHOLD = 5_000;
const MAX_ATTACHMENT_CHARS = 500_000;
const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)[\w-]+/i;
const URL_REGEX = /^https?:\/\/[^\s]+$/i;

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
  const { isAdmin } = useAdminAuth();
  const navigate = useNavigate();
  // Upgrade dialog for free users who configure an autopost schedule.
  // ScheduleBlock now lets free users walk the entire flow; we only
  // surface the upsell when they hit Generate. The dialog is rendered
  // at the bottom of the component. `planEligibleForAutopost` is
  // computed below once the local `plan` variable lands (the file
  // already has its own subscription useQuery — no need to call
  // useSubscription a second time and shadow it).
  const [autopostUpgradeOpen, setAutopostUpgradeOpen] = useState(false);

  // ── Autopost schedule state — lifted up from <ScheduleBlock /> so
  //    handleGenerate() can branch on whether the user is creating a
  //    one-shot project or a recurring autopost schedule. The block
  //    itself is rendered inside <IntakeRail /> just above the CTA. ──
  const [scheduleState, setScheduleState] = useState<ScheduleState>({
    enabled: false,
    interval: 'daily',
    topics: [],
    generatedTopics: [],
    platformAccountIds: [],
    deliveryMethod: 'social',
    emailRecipients: [],
    termsAgreed: false,
  });

  const [prompt, setPrompt] = useState(initialPrompt);
  // Source attachments for the prompt — Add source / File / URL
  // buttons populate this, processAttachments() concatenates them
  // to the prompt text on submit so the worker sees the full source
  // material. Same SourceAttachment shape the legacy workspaces use.
  const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [aspect, setAspect] = useState<IntakeAspect>(aspectFromFormat(initialFormat));
  const [duration, setDuration] = useState<IntakeDuration>('<3min');
  // Cinematic mode caps at <3 min — kicking back to short whenever the
  // user switches into cinematic with a stale long-form selection.
  useEffect(() => {
    if (mode === 'cinematic' && duration === '>3min') setDuration('<3min');
  }, [mode, duration]);
  const [language, setLanguage] = useState(initialLanguage);
  const [voice, setVoice] = useState<SpeakerVoice>(
    (initialVoice as SpeakerVoice) || getDefaultSpeaker(initialLanguage),
  );
  // Default to 'none' so projects don't bake captions into the export
  // unless the user explicitly opts in. Captions can be enabled in
  // Editor → Inspector at any time without re-running the export.
  const [caption, setCaption] = useState<CaptionStyle>('none');
  const [brand, setBrand] = useState('');

  const [styleId, setStyleId] = useState('realistic');
  const [customStyle, setCustomStyle] = useState('');
  const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
  const [uploadingStyle, setUploadingStyle] = useState(false);

  const [tone, setTone] = useState(45);
  const [camera, setCamera] = useState<CameraMotion>('Default');
  const [transition, setTransition] = useState<SceneTransition>('Default');
  const [grade, setGrade] = useState<ColorGrade>('Kodak 250D');

  const [lipSync, setLipSync] = useState(false);
  const [lipStrength, setLipStrength] = useState(70);
  // Music + SFX state — UI block is commented out while Lyria is
  // unstable. Setters dropped from the destructure (TS6133) since the
  // only writes lived inside the disabled JSX. The values are still
  // read by the cost summary's useMemo deps array below.
  const [music] = useState(false);
  const [musicGenre] = useState<MusicGenre>('Cinematic');
  const [sfx] = useState(false);

  // Character consistency is FORCED ON when the mode supports it — the
  // base credit cost already covers it, so it's not a toggle.
  const consistency = features.cast;
  const [characterDescription, setCharacterDescription] = useState('');
  const [characterImages, setCharacterImages] = useState<string[]>([]);
  // Separate from `sourceAttachments` — these apply only to the
  // character-consistency block (additional text/link references that
  // describe the lead's look).
  const [characterAttachments, setCharacterAttachments] = useState<SourceAttachment[]>([]);

  const [generating, setGenerating] = useState(false);

  // C-7-12 (Ghost G-C1+G-C2): synchronous client-side lock against
  // Enter-mash / double-submit. `setGenerating(true)` flips React
  // state but won't STOP a second handleGenerate call dispatched
  // before React re-renders the disabled button — the lock has to be
  // a ref that we read+write synchronously inside the same event
  // tick. Server-side dedup (create_project_idempotent RPC) is the
  // belt; this ref is the suspenders + saves a round-trip on the
  // 99% case.
  const submitLockRef = useRef(false);
  // The idempotency key is generated ONCE per logical submit and
  // re-used for any retry inside this submit. We bind it to the
  // submitLockRef lifecycle: cleared when the submit completes
  // (success or error) so the NEXT click gets a fresh key.
  const idempotencyKeyRef = useRef<string | null>(null);

  // C-5-7: style carousel scroll-controls + ref now live inside
  // <StyleCarousel /> (lazy chunk). The parent only owns the styleId
  // value and the custom-style input/upload state.

  const speakersForLang = useMemo(() => getSpeakersForLanguage(language), [language]);
  // User's cloned voices — surfaced at the TOP of the voice select.
  // The reset-on-language-change guard below treats clone:* picker IDs
  // as always valid (clones speak any language via Fish s2-pro).
  const { data: userClones = [] } = useUserClones();
  useEffect(() => {
    const isClone = typeof voice === "string" && voice.startsWith("clone:");
    if (isClone) return;
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
  // Autopost upsell uses the same `plan` variable so we never disagree
  // with the cost-summary's notion of which tier the user is on.
  const planEligibleForAutopost = isAutopostEligible(plan);

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
    // Binary (PDF/doc/etc.) — store a real blob URL so the upload
    // helpers can fetch the actual bytes. The previous "data:<mime>"
    // placeholder string had no payload and tripped CSP connect-src
    // when processAttachments tried to fetch it.
    else value = URL.createObjectURL(file);
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

  /** Paste handler used by the Sources textarea. Matches the legacy
   *  workspace SourceInput behaviour:
   *    1. Clipboard image       → image chip
   *    2. YouTube URL(s)        → youtube chip(s) (multiple allowed
   *                               separated by newlines/commas)
   *    3. Plain URL             → link chip (auto-typed by host)
   *    4. Long text > 5_000ch   → text chip (preview + (Nk chars))
   *    5. Short text            → default textarea paste
   *  Critical: step 4 is what the user's 10k-word pastes need —
   *  without it the textarea swallows everything and the attachments
   *  list never gets a chip. */
  const handlePasteForSources = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);

    // 1. Image
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItem) {
      const f = imageItem.getAsFile();
      if (f) {
        e.preventDefault();
        void attachFileToSources(f);
        toast.success('Pasted image attached.');
        return;
      }
    }

    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    // 2. YouTube URL(s)
    if (YOUTUBE_REGEX.test(text.trim())) {
      e.preventDefault();
      const urls = text.trim().split(/[\n,]+/).filter((u) => YOUTUBE_REGEX.test(u.trim()));
      for (const url of urls) {
        setSourceAttachments((prev) => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'youtube',
          name: url.trim().length > 40 ? url.trim().slice(0, 40) + '…' : url.trim(),
          value: url.trim(),
        }]);
      }
      toast.success(`${urls.length} YouTube link${urls.length === 1 ? '' : 's'} attached.`);
      return;
    }

    // 3. Plain URL
    if (URL_REGEX.test(text.trim())) {
      if (tryAttachUrl(text, 'sources')) { e.preventDefault(); return; }
    }

    // 4. Long text → auto-attach as a text chip
    if (text.length > AUTO_ATTACH_THRESHOLD) {
      e.preventDefault();
      const preview = text.substring(0, 60).replace(/\n/g, ' ') + '…';
      const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
      setSourceAttachments((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'text',
        name: `${preview} (${(clipped.length / 1000).toFixed(0)}K chars)`,
        value: clipped,
      }]);
      toast.success(`Pasted ${(clipped.length / 1000).toFixed(0)}K of text attached.`);
      return;
    }

    // 5. Short text → default textarea paste
  };

  /** Same ladder for the Character textarea — images flow into the
   *  reference grid instead of the attachments list, long text goes
   *  into characterAttachments so it augments the description. */
  const handlePasteForCharacter = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);

    // 1. Image → character reference grid
    const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (imageItem) {
      const f = imageItem.getAsFile();
      if (f) {
        e.preventDefault();
        const dt = new DataTransfer();
        dt.items.add(f);
        handleCharImageUpload(dt.files);
        return;
      }
    }

    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;

    // 2. URL → reference link chip
    if (URL_REGEX.test(text.trim()) || YOUTUBE_REGEX.test(text.trim())) {
      if (tryAttachUrl(text, 'character')) { e.preventDefault(); return; }
    }

    // 3. Long text → attach as a text chip under the character block
    if (text.length > AUTO_ATTACH_THRESHOLD) {
      e.preventDefault();
      const preview = text.substring(0, 60).replace(/\n/g, ' ') + '…';
      const clipped = text.substring(0, MAX_ATTACHMENT_CHARS);
      setCharacterAttachments((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'text',
        name: `${preview} (${(clipped.length / 1000).toFixed(0)}K chars)`,
        value: clipped,
      }]);
      toast.success(`Pasted ${(clipped.length / 1000).toFixed(0)}K of reference text attached.`);
      return;
    }

    // 4. Short text → default textarea paste
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

    // C-7-12 (Ghost G-C1+G-C2): synchronous submit lock. setGenerating
    // is async (React batches state updates) so a second Enter press
    // arriving in the same event loop tick would slip past a check on
    // `generating` and fire a duplicate INSERT (= duplicate project
    // row + double credit charge). The ref check runs synchronously
    // — second click sees the locked ref and returns immediately.
    if (submitLockRef.current) {
      toast.info('Already generating — hold on.');
      return;
    }
    submitLockRef.current = true;
    // Mint a per-submit idempotency key. Stored on the ref so any
    // server-side retry inside this submit reuses the same key; the
    // server collapses both writes to one project row.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    setGenerating(true);
    try {
      const intakeSettings: IntakeSettings = {
        visualStyle: styleId,
        tone,
        ...(features.camera ? { camera } : {}),
        ...(features.transition ? { transition } : {}),
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
      // Resolve the picker selection: if the user picked a cloned
      // voice (id prefixed with `clone:`), this returns voice_type
      // 'custom' + the external Fish/ElevenLabs id so the audio
      // router routes through the right TTS provider.
      const resolvedVoice = resolveVoiceForProject(voice as string, userClones);

      const projectInsert: Record<string, unknown> = {
        user_id: user.id,
        title,
        content: enrichedContent,
        project_type: mode,
        format: formatFromAspect(aspect),
        length,
        voice_name: resolvedVoice.voice_name,
        voice_type: resolvedVoice.voice_type,
        voice_id: resolvedVoice.voice_id,
        voice_inclination: language,
        style: styleId,
        character_description: enrichedCharDesc || null,
        character_consistency_enabled: consistency,
        character_images: characterImages.length > 0 ? characterImages : null,
        intake_settings: intakeSettings,
      };

      // ── Autopost branch ──
      // When the user has the schedule toggle ON, agreed to the terms,
      // and picked a frequency, we DO NOT create a one-shot project.
      // Instead we insert into autopost_schedules; pg_cron's
      // autopost_tick() picks the row up on the next minute, pops a
      // topic off the queue, and inserts the actual generation job
      // with task_type='autopost_render'. The shadow-copy
      // config_snapshot column carries the full IntakeSettings frozen
      // at create-time so edits to the schedule never retroactively
      // rewrite already-queued runs.
      //
      // Validation gates: must have an interval, at least one topic
      // queued (prompt-only schedules are too easy to abuse), and at
      // least one platform account selected so the dispatcher has
      // somewhere to publish to.
      if (scheduleState.enabled && scheduleState.termsAgreed) {
        // Free-plan upsell. ScheduleBlock allows free users to flip
        // the Schedule toggle on and walk the whole flow (so they can
        // see the value of the feature with their own topics + cadence
        // mapped out) — but at submit time we open the upgrade dialog
        // instead of inserting the row. The DB-side INSERT RLS policy
        // (creator+ inserts own schedules) is the secondary gate; this
        // client-side check is the user-facing one that explains WHY
        // the upgrade is needed instead of failing with a Postgres
        // RLS error toast.
        if (!planEligibleForAutopost) {
          setAutopostUpgradeOpen(true);
          return;
        }
        if (!scheduleState.interval) {
          toast.error('Pick how often the schedule should run.');
          return;
        }
        if (scheduleState.topics.length === 0) {
          toast.error('Generate topics and select at least one to queue.');
          return;
        }
        // Wave E — delivery-method gates. Social still requires at
        // least one connected platform account; email needs at least
        // one recipient; library_only has no extra requirement so the
        // user can schedule with zero side-effects beyond Run History.
        if (scheduleState.deliveryMethod === 'social'
            && scheduleState.platformAccountIds.length === 0) {
          toast.error('Pick at least one platform or change delivery method.');
          return;
        }
        if (scheduleState.deliveryMethod === 'email'
            && scheduleState.emailRecipients.length === 0) {
          toast.error('Add at least one email recipient.');
          return;
        }

        const cronExpr = INTERVAL_TO_CRON[scheduleState.interval];
        // Duration is no longer a flat per-schedule cap. Each flow
        // (smartflow / cinematic / doc2video) decides its own scene
        // count + pacing from the LLM script and from `length`. The
        // schedule row's duration_seconds column is informational only
        // — keep it null and let dashboards estimate from `length`.
        const resolution = aspect === '16:9' ? '1920x1080' : '1080x1920';

        const scheduleInsert = await supabase
          .from('autopost_schedules')
          .insert({
            user_id: user.id,
            name: enrichedContent.slice(0, 60) || title,
            active: true,
            prompt_template: enrichedContent,
            topic_pool: scheduleState.topics,
            motion_preset: features.camera ? camera : null,
            duration_seconds: null,
            resolution,
            cron_expression: cronExpr,
            timezone: 'UTC',
            // Compute the FIRST matching slot for the chosen cron (UTC).
            // The previous hardcoded NOW+60s meant a "Daily at 9am"
            // schedule still pretended to fire in a minute, then drifted
            // into the past once pg_cron's autopost_tick advanced past
            // it. Worker re-stamps next_fire_at after each fire via the
            // autopost_advance_next_fire RPC, so this is just the first
            // anchor.
            next_fire_at: (
              nextFireFromCron(cronExpr, 'UTC', new Date())
              ?? new Date(Date.now() + 60_000)
            ).toISOString(),
            // Only carry the platform IDs when we're actually publishing
            // to social — email/library_only modes leave it empty.
            target_account_ids: scheduleState.deliveryMethod === 'social'
              ? scheduleState.platformAccountIds
              : [],
            delivery_method: scheduleState.deliveryMethod,
            email_recipients: scheduleState.emailRecipients,
            // Default caption is intentionally tiny — the prompt is the
            // generation instruction, the caption is what gets posted
            // ALONGSIDE each video. User edits it later via the Edit
            // dialog. {topic} interpolates the queued topic for that run.
            caption_template: '{topic}',
            hashtags: [],
            ai_disclosure: true,
            // Shadow copy — frozen creative prefs the worker reads on
            // every queue-pop so schedule edits don't rewrite history.
            config_snapshot: {
              intake_settings: intakeSettings,
              mode,
              language,
              voice_name: resolvedVoice.voice_name,
              voice_type: resolvedVoice.voice_type,
              voice_id: resolvedVoice.voice_id,
              format: formatFromAspect(aspect),
              length,
              style: styleId,
              character_description: enrichedCharDesc || null,
              character_consistency_enabled: consistency,
              character_images: characterImages.length > 0 ? characterImages : null,
            },
          } as never)
          .select('id')
          .single();

        if (scheduleInsert.error || !scheduleInsert.data) {
          throw scheduleInsert.error ?? new Error('Schedule insert returned no row');
        }

        // §11 Lens C3 — adoption signal for autopost. delivery_method
        // disambiguates "I scheduled to publish socially" from "I scheduled
        // for email digest" — those are different jobs-to-be-done.
        try {
          trackEvent(EVENTS.automation_created, {
            delivery_method: scheduleState.deliveryMethod,
            interval: scheduleState.interval ?? 'unspecified',
            topic_count: scheduleState.topics.length,
            platform_count: scheduleState.platformAccountIds.length,
          });
        } catch { /* analytics non-critical */ }

        toast.success('Automation created — first run scheduled.');
        navigate('/lab/autopost');
        return;
      }

      // C-7-12: route the insert through the idempotent RPC. The RPC
      // does (user_id, idempotency_key) dedup + a 5-second soft window
      // dedup on (title, content, project_type) so an Enter-mash from
      // a stale client without a key still collapses to one row.
      // Returns the (existing or new) project id; the client treats
      // both cases identically — navigate to the editor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpcResult = await (supabase.rpc as any)('create_project_idempotent', {
        p_idempotency_key: idempotencyKeyRef.current,
        p_payload: projectInsert,
      });
      if (rpcResult.error) {
        // Schema-drift / not-yet-migrated fallback: if the RPC doesn't
        // exist on this DB (404 / PGRST202), fall back to the direct
        // insert path. Production gets the safe path; staging that
        // hasn't applied the migration yet still works (and surfaces
        // the older duplicate-row risk until the migration lands).
        const msg = (rpcResult.error.message || '').toLowerCase();
        const missingRpc = msg.includes('does not exist')
          || msg.includes('not found')
          || msg.includes('pgrst202')
          || msg.includes('schema cache');
        if (!missingRpc) {
          throw new Error(rpcResult.error.message || 'Project creation failed');
        }
        console.warn('[IntakeForm] create_project_idempotent RPC missing — falling back to direct insert');
        const insertResult = await supabase.from('projects').insert(projectInsert as never).select('id').single();
        if (insertResult.error && insertResult.error.message?.toLowerCase().includes('intake_settings')) {
          const dbMsg = 'Database is missing the intake_settings column. Apply migration 20260422010000 (intake settings JSONB) before generating.';
          console.error('[IntakeForm] schema drift:', insertResult.error);
          throw new Error(dbMsg);
        }
        const { data, error } = insertResult;
        if (error || !data) throw error || new Error('Insert returned no row');
        toast.success('Project created. Taking you to the editor…');
        navigate(`/app/editor/${data.id}?autostart=1`);
        return;
      }

      const projectId = rpcResult.data as string | null;
      if (!projectId) throw new Error('Project creation returned no id');

      toast.success('Project created. Taking you to the editor…');
      // Legacy WorkspaceRouter retired — always route to the unified
      // editor. UNIFIED_EDITOR flag is now effectively a no-op.
      navigate(`/app/editor/${projectId}?autostart=1`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't save project: ${msg}`);
    } finally {
      setGenerating(false);
      // C-7-12: release the submit lock + clear the idempotency key
      // so the next legitimate submit gets a fresh one. Error path
      // also clears, which means the user CAN retry (with a fresh
      // key) after fixing whatever the error was; the 5s soft-window
      // dedup is the safety net against accidental rapid retries.
      submitLockRef.current = false;
      idempotencyKeyRef.current = null;
    }
  }

  // Bridge cost + rail content into IntakeFrame.
  //
  // Rail injection used to fire on every keystroke in the prompt textarea
  // (each character → new <IntakeRail/> JSX → full right-rail subtree
  // re-render: credits card, voice player, suggestions, CTA). Now we
  // debounce the rail update by 200 ms so live typing doesn't thrash
  // the rail; cost (the only number the user wants to see update fast)
  // still propagates immediately via setTotalCost. The 200 ms cap is
  // below the perception threshold for "instant" so users still see the
  // rail reflect their edits without paying the per-keystroke render.
  const rail = useIntakeRail();
  // Cost mirror — stays sync, ~free
  useEffect(() => {
    rail.setTotalCost(totalCost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCost]);

  // Heavy rail content — debounced
  useEffect(() => {
    const timer = setTimeout(() => {
      rail.setRailContent(
        <IntakeRail
          aspect={aspect}
          prompt={prompt}
          mode={mode}
          visualStyle={{ name: styleLabelFor(styleId) }}
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
          isAdmin={isAdmin}
          scheduleState={scheduleState}
          onScheduleChange={setScheduleState}
          intakeSummary={{ prompt, styleId, aspect, voice, language, sourceAttachments }}
        />,
      );
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect, prompt, mode, styleId, language, voice, caption, duration, consistency, characterDescription, music, lipSync, features, costItems, totalCost, credits, creditsCap, generating, isAdmin, scheduleState]);

  // C-5-7: `selectedStyle` lookup moved into the lazy StyleCarousel
  // chunk so this parent component doesn't need the STYLES table.

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
            className="w-full min-h-[100px] bg-transparent border-0 outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] rounded-sm text-[#ECEAE4] font-serif text-[16px] sm:text-[16px] leading-[1.5] resize-y p-4"
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
                      value = URL.createObjectURL(f);
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
                // TODO(intake-url-input-polish): replace with themed inline input dialog
                // (see roadmap MED — window.prompt non-styleable + leaks
                // typed values to the browser's prompt history). The
                // URL constructor below validates the host so a paste
                // of secrets is at least never persisted by us.
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
              <Wand2 className="w-3 h-3" /> Smart prompt
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
                    className="text-[#8A9198] hover:text-[#E4C875] px-1.5 py-1 -my-1 -mx-1 rounded-md text-[14px] leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60"
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
              {([['<3min', '< 3 min'], ['>3min', '> 3 min']] as Array<[IntakeDuration, string]>).map(([v, t]) => {
                // Cinematic per-scene Kling renders are expensive — a >3min
                // run can mean 30+ video clips and tens of dollars. Disable
                // the long option for cinematic and let users pick it for
                // the cheaper doc2video / smartflow modes.
                const isLongCinematic = mode === 'cinematic' && v === '>3min';
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { if (!isLongCinematic) setDuration(v); }}
                    disabled={isLongCinematic}
                    title={isLongCinematic ? 'Long-form (>3 min) is not available for cinematic projects.' : undefined}
                    className={cn(
                      'px-3 py-1.5 rounded-md font-mono text-[11px] tracking-wider transition-colors',
                      isLongCinematic
                        ? 'text-[#5A6268] opacity-40 cursor-not-allowed'
                        : v === duration
                          ? 'bg-[#14C8CC]/10 text-[#14C8CC]'
                          : 'text-[#8A9198] hover:text-[#ECEAE4]',
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Language / Voice / Captions / Brand */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
        <div>
          <IntakeLabel htmlFor="intake-language">Narration language</IntakeLabel>
          <select
            id="intake-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-base sm:text-[13px] text-[#ECEAE4] outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] focus:border-[#14C8CC]/50"
          >
            {/* Per-option `lang` + `aria-label` (C-1-2 / Halo F-A11Y-006):
                tells the screen-reader's TTS engine to switch voice
                synthesizer for native-script labels and provides an
                English-language fallback announcement. */}
            {LANGUAGES.map((l) => (
              <option
                key={l.code}
                value={l.code}
                lang={l.code}
                aria-label={`${l.label} (${l.englishName})`}
              >
                {l.flag} {l.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <IntakeLabel htmlFor="intake-voice">Voice</IntakeLabel>
          <select
            id="intake-voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value as SpeakerVoice)}
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-base sm:text-[13px] text-[#ECEAE4] outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] focus:border-[#14C8CC]/50"
          >
            {/* User's cloned voices — pinned to the top so they're
                discoverable. Empty optgroup is omitted. */}
            {userClones.length > 0 && (
              <optgroup label="✨ Your cloned voices">
                {userClones.map((c) => (
                  <option key={c.pickerId} value={c.pickerId}>
                    {c.name} · {c.description}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Studio voices">
              {speakersForLang.map((s) => (
                <option key={s.id} value={s.id}>{s.label} · {s.description}</option>
              ))}
            </optgroup>
          </select>
        </div>
        <div>
          <IntakeLabel>Captions</IntakeLabel>
          <div className="bg-[#151B20] border border-white/5 rounded-lg px-2 py-1.5">
            <CaptionStyleSelector value={caption} onChange={setCaption} showLabel={false} />
          </div>
        </div>
        <div>
          <IntakeLabel htmlFor="intake-brand">Brand name</IntakeLabel>
          <input
            id="intake-brand"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Your brand (optional)"
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-base sm:text-[13px] text-[#ECEAE4] outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
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
      Original "Audio & realism" block with the Music + SFX toggle was
      removed when Lyria became unreliable. Restore the FeatureToggle
      for music from git history (look for "Music & Sound Effects")
      when the provider is stable again.
      */}

      {/* Character consistency — ALWAYS ON for cinematic + explainer.
          C-5-7 (Prism PERF-011): the entire block is now a lazy-loaded
          React.lazy chunk so non-cinematic / non-explainer modes never
          download it. Mounted under <Suspense> only when the mode's
          features.characterAppearance is on. */}
      {consistency && features.characterAppearance && (
        <Suspense fallback={<StepLoadingSkeleton height={200} />}>
          <CharacterConsistencyBlock
            characterDescription={characterDescription}
            onCharacterDescriptionChange={setCharacterDescription}
            onPaste={handlePasteForCharacter}
            onDrop={handleDropForCharacter}
            characterImages={characterImages}
            onCharImageRemove={(i) => setCharacterImages((p) => p.filter((_, j) => j !== i))}
            onCharImageUpload={handleCharImageUpload}
            characterAttachments={characterAttachments}
            onCharAttachmentRemove={(id) => setCharacterAttachments((prev) => prev.filter((x) => x.id !== id))}
            onCharAttachmentFile={async (files) => {
              const list = Array.from(files ?? []);
              if (list.length === 0) return;
              const added: SourceAttachment[] = [];
              for (const f of list) {
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
                else value = URL.createObjectURL(f);
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
            }}
            onCharAttachmentUrl={() => {
              const raw = window.prompt('Paste a URL to a character reference photo or profile:');
              if (!raw) return;
              if (!tryAttachUrl(raw, 'character')) {
                toast.error("That doesn't look like a valid URL.");
              }
            }}
          />
        </Suspense>
      )}

      {/* Visual style — lazy-loaded chunk owns the 17 image-preview
          handles + the carousel scroll controls (C-5-7 / PERF-011). */}
      <Suspense fallback={<StepLoadingSkeleton height={180} />}>
        <StyleCarousel
          styleId={styleId}
          onStyleChange={setStyleId}
          customStyle={customStyle}
          onCustomStyleChange={setCustomStyle}
          customStyleImage={customStyleImage}
          onCustomStyleImageChange={setCustomStyleImage}
          uploadingStyle={uploadingStyle}
          onCustomStyleImageUpload={handleCustomStyleImageUpload}
        />
      </Suspense>

      {/* Direction: Tone / Camera / Grade — lazy-loaded chunk owns the
          CAMERA_MOTIONS / SCENE_TRANSITIONS / COLOR_GRADES tables and
          the slider/pill JSX (C-5-7 / PERF-011). */}
      <Suspense fallback={<StepLoadingSkeleton height={140} />}>
        <DirectionBlock
          tone={tone}
          onToneChange={setTone}
          showCamera={!!features.camera}
          camera={camera}
          onCameraChange={setCamera}
          showTransition={!!features.transition}
          transition={transition}
          onTransitionChange={setTransition}
          showColorGrade={!!features.colorGrade}
          grade={grade}
          onGradeChange={setGrade}
        />
      </Suspense>

      {/* Mobile Generate button (desktop uses the rail CTA) */}
      <button
        type="submit"
        disabled={generating}
        className="lg:hidden w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-[14px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] disabled:opacity-60"
      >
        {generating ? 'Submitting…' : `Create Video · ${totalCost} cr`}
      </button>

      {/* Free-plan autopost upsell.
          Shown when a free user hits Generate with the schedule toggle
          on. We let them walk the whole setup flow first so the value
          is concrete (your topics, your cadence, your delivery method)
          before asking for an upgrade — much warmer pitch than blocking
          the toggle on click. Closing the dialog leaves the form state
          intact so the user can either upgrade and re-submit, or flip
          the schedule off and create a one-shot project instead. */}
      {(() => {
        // C-8-6: compute the REAL per-run credit cost from the user's
        // current mode + duration pick. Mirrors public.autopost_credits_required(mode,length)
        // exactly — same formula, same numbers. Replacing the old flat-45
        // copy so the upsell dialog shows the actual charge instead of
        // a misleading lowball.
        const _autopostLength: 'short' | 'brief' | 'presentation' =
          features.duration && duration === '>3min' ? 'presentation' : 'short';
        const _autopostMode = mode as 'doc2video' | 'smartflow' | 'cinematic';
        const _autopostCredits = getAutopostCreditsRequired(_autopostMode, _autopostLength);
        return (
          <Dialog open={autopostUpgradeOpen} onOpenChange={setAutopostUpgradeOpen}>
            <DialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4] max-w-md">
              <DialogHeader>
                <DialogTitle className="text-[#ECEAE4]">Autopost is a Creator+ feature</DialogTitle>
                <DialogDescription className="text-[#8A9198]">
                  Your schedule is configured and ready to run, but recurring
                  automation is reserved for paid plans. Upgrade to start
                  firing this schedule automatically — about {_autopostCredits} credits per run
                  at your current {MODE_LABEL[mode]} settings.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border border-[#14C8CC]/25 bg-[#14C8CC]/[0.06] px-3 py-2.5 text-[12.5px] text-[#ECEAE4] leading-[1.55]">
                <div className="font-medium text-[#14C8CC] mb-1">What you'll unlock</div>
                <ul className="list-disc pl-4 text-[#8A9198] space-y-0.5">
                  <li>Run topics on your cadence (hourly to weekly)</li>
                  <li>Email or social-publish each finished video</li>
                  <li>~{_autopostCredits} credits per run at these settings (varies by mode and length — Cinematic + Presentation runs cost more)</li>
                </ul>
              </div>
              <DialogFooter className="gap-2 flex-col-reverse sm:flex-row">
                <Button
                  variant="outline"
                  onClick={() => setAutopostUpgradeOpen(false)}
                  className="border-white/10 bg-transparent text-[#8A9198] hover:bg-white/5 hover:text-[#ECEAE4]"
                >
                  Maybe later
                </Button>
                <Button
                  onClick={() => navigate('/pricing')}
                  className="bg-gradient-to-r from-[#14C8CC] to-[#E4C875] text-[#0A0D0F] hover:opacity-90"
                >
                  View plans
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}
    </form>
  );
}
