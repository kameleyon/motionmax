import { useEffect, useRef, useState } from 'react';
import { Play, Loader2, Square, Info, AlertTriangle, Sparkles, Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import {
  CaptionStyleSelector,
  type CaptionStyle,
  previewStyles,
} from '@/components/workspace/CaptionStyleSelector';
import { IntakeField, IntakeLabel } from './primitives';
import type { IntakeAspect, ProjectMode } from './types';

/** Tip shown in the Suggestions card. Surfaced when a condition holds —
 *  see `buildSuggestions` below for the rules. */
type Tip = {
  id: string;
  icon: 'info' | 'warn' | 'idea' | 'spark';
  body: string;
};

/** Strip the sm:/sm2:/gm: provider prefix so "sm:quinn" renders as
 *  "Quinn" in the setup recap. */
function prettyVoice(raw: string): string {
  const s = raw.replace(/^(sm2?|gm):/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const LANGUAGE_LABEL: Record<string, string> = {
  en: 'English', fr: 'Français', es: 'Español', ht: 'Kreyòl',
  de: 'Deutsch', it: 'Italiano', nl: 'Nederlands',
  ru: 'Русский', zh: '中文', ja: '日本語', ko: '한국어',
};

function buildSuggestions(args: {
  mode: ProjectMode;
  prompt: string;
  language: string;
  voice: string;
  consistency: boolean;
  characterDescriptionLen: number;
  music: boolean;
  lipSync: boolean;
  styleId: string;
  totalCost: number;
  creditsAvailable: number;
}): Tip[] {
  const tips: Tip[] = [];

  if (args.prompt.trim().length < 20) {
    tips.push({
      id: 'short-prompt',
      icon: 'idea',
      body: 'Richer prompts (2–3 sentences) give the script model more to work with — you\'ll see tighter scene pacing.',
    });
  }
  if (args.consistency && args.characterDescriptionLen < 30) {
    tips.push({
      id: 'no-character',
      icon: 'warn',
      body: 'Character consistency is on, but you haven\'t described your lead yet. Add a short description so every scene stays on-model.',
    });
  }
  if (!args.music && args.mode === 'cinematic') {
    tips.push({
      id: 'no-music',
      icon: 'spark',
      body: 'Music lifts cinematic reels a lot. Lyria 3 Pro scores the whole piece for +60 cr — auto-ducks under narration.',
    });
  }
  if (args.lipSync && args.mode !== 'cinematic') {
    // Safety — lipSync shouldn't even show for non-cinematic, but guard anyway.
    tips.push({
      id: 'no-lipsync',
      icon: 'warn',
      body: 'Lip sync only applies when characters are on-screen speaking. Explainer/Smart Flow skip it automatically.',
    });
  }
  // Voice / language mismatch — Adam and River are English-only legacy voices.
  if (['Adam', 'River'].includes(args.voice) && args.language !== 'en') {
    tips.push({
      id: 'voice-lang-mismatch',
      icon: 'warn',
      body: `${args.voice} only speaks English. Pick a voice from the ${LANGUAGE_LABEL[args.language] ?? args.language} list for natural pronunciation.`,
    });
  }
  if (args.totalCost > args.creditsAvailable) {
    tips.push({
      id: 'insufficient-credits',
      icon: 'warn',
      body: `You need ${args.totalCost.toLocaleString()} cr but only ${args.creditsAvailable.toLocaleString()} are available. Top up before you hit Create.`,
    });
  }
  if (args.styleId === 'custom') {
    tips.push({
      id: 'custom-style',
      icon: 'info',
      body: 'Custom style: describe the look plainly ("1970s 16mm film, grainy, warm") or upload one reference image — the model will stylise from it.',
    });
  }
  // Default nice-to-have when nothing else fires.
  if (tips.length === 0) {
    tips.push({
      id: 'ready',
      icon: 'spark',
      body: 'Looking good. When you hit Create, MotionMax drafts the script, generates scenes, layers audio, and delivers to All Projects.',
    });
  }
  return tips.slice(0, 3);
}

function voiceCacheGet(key: string): string | null {
  try {
    const raw = localStorage.getItem('motionmax_voice_previews') || '{}';
    return (JSON.parse(raw)[key] as string) ?? null;
  } catch { return null; }
}
function voiceCacheSet(key: string, url: string) {
  try {
    const raw = localStorage.getItem('motionmax_voice_previews') || '{}';
    const map = JSON.parse(raw);
    map[key] = url;
    localStorage.setItem('motionmax_voice_previews', JSON.stringify(map));
  } catch { /* quota */ }
}

const TIP_ICON: Record<Tip['icon'], typeof Info> = {
  info: Info,
  warn: AlertTriangle,
  idea: Lightbulb,
  spark: Sparkles,
};
const TIP_COLOR: Record<Tip['icon'], string> = {
  info: 'text-[#14C8CC]',
  warn: 'text-[#E4C875]',
  idea: 'text-[#14C8CC]',
  spark: 'text-[#14C8CC]',
};

/** Right-rail content — credits snapshot, setup recap (voice + caption
 *  previews), contextual suggestions, Generate CTA. Replaces the old
 *  AI-preview + storyboard cards, which were aspirational rather than
 *  functional (nothing's generated until the user hits Create). */
export default function IntakeRail({
  aspect, prompt, mode, visualStyle,
  language, voice, captionStyle, duration,
  consistency, characterDescriptionLen,
  music, lipSync, styleId,
  costItems, totalCost, creditsAvailable, onGenerate, generating,
  creditsCap,
}: {
  aspect: IntakeAspect;
  prompt: string;
  mode: ProjectMode;
  visualStyle: { name: string };
  language: string;
  voice: string;
  captionStyle: CaptionStyle;
  duration?: string;
  consistency: boolean;
  characterDescriptionLen: number;
  music: boolean;
  lipSync: boolean;
  styleId: string;
  costItems: Array<{ label: string; v: number }>;
  totalCost: number;
  creditsAvailable: number;
  creditsCap: number;
  onGenerate: () => void;
  generating?: boolean;
}) {
  const { user } = useAuth();

  // ── Voice preview playback (shared pattern with SpeakerSelector) ──
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const stopPreview = () => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setPreviewPlaying(false);
  };

  const playVoice = async () => {
    if (!user) return;
    if (previewPlaying) { stopPreview(); return; }

    const langKey = language || 'en';
    const cacheKey = `${voice}_${langKey}`;
    const cached = voiceCacheGet(cacheKey);
    if (cached) {
      const audio = new Audio(cached);
      audioRef.current = audio;
      setPreviewPlaying(true);
      audio.onended = () => setPreviewPlaying(false);
      audio.onerror = () => setPreviewPlaying(false);
      audio.play().catch(() => setPreviewPlaying(false));
      return;
    }

    setPreviewLoading(true);
    try {
      const sampleText = `Hello, I'm ${prettyVoice(voice)}. This is how my voice sounds for your video.`;
      const { data: job, error } = await supabase
        .from('video_generation_jobs')
        .insert({
          user_id: user.id,
          task_type: 'voice_preview',
          payload: { speaker: voice, language: langKey, text: sampleText } as unknown as never,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error || !job) throw new Error('queue failed');

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const { data: row } = await supabase
          .from('video_generation_jobs')
          .select('status, result')
          .eq('id', job.id)
          .single();
        const audioUrl = (row?.result as { audioUrl?: string } | null)?.audioUrl;
        if (row?.status === 'completed' && audioUrl) {
          voiceCacheSet(cacheKey, audioUrl);
          const audio = new Audio(audioUrl);
          audioRef.current = audio;
          setPreviewPlaying(true);
          audio.onended = () => setPreviewPlaying(false);
          audio.onerror = () => setPreviewPlaying(false);
          audio.play().catch(() => setPreviewPlaying(false));
          break;
        }
        if (row?.status === 'failed') throw new Error('voice preview failed');
      }
    } catch {
      toast.error('Voice preview unavailable. Try again in a moment.');
    } finally {
      setPreviewLoading(false);
    }
  };

  // Credits percentages
  const usagePct = creditsCap > 0
    ? Math.min(100, Math.round(((creditsCap - creditsAvailable) / creditsCap) * 100))
    : 0;
  const afterGenerate = Math.max(0, creditsAvailable - totalCost);
  const afterPct = creditsCap > 0
    ? Math.min(100, Math.round(((creditsCap - afterGenerate) / creditsCap) * 100))
    : 0;
  const overBudget = totalCost > creditsAvailable;

  const tips = buildSuggestions({
    mode, prompt, language, voice, consistency, characterDescriptionLen,
    music, lipSync, styleId, totalCost, creditsAvailable,
  });

  // Caption preview CSS — prettyStyles[captionStyle] is a Tailwind class
  // string that renders the chosen caption treatment at real pixel size.
  const captionCss = previewStyles[captionStyle] ?? '';

  return (
    <>
      {/* Credits & usage */}
      <IntakeField className="p-4">
        <IntakeLabel>Credits & usage</IntakeLabel>
        <div className="flex items-baseline gap-2 mb-3">
          <span className="font-serif text-[30px] font-medium text-[#ECEAE4] leading-none">
            {creditsAvailable.toLocaleString()}
          </span>
          <span className="font-mono text-[11px] text-[#5A6268] tracking-wider">
            / {creditsCap.toLocaleString()}
          </span>
        </div>

        <div className="relative h-1.5 rounded-full bg-[#1B2228] border border-white/5 overflow-hidden">
          {/* Used portion (current) */}
          <div
            className="absolute inset-y-0 left-0 bg-[#14C8CC]/40"
            style={{ width: `${usagePct}%` }}
          />
          {/* Projected after this generation */}
          <div
            className={`absolute inset-y-0 left-0 ${overBudget ? 'bg-[#E66666]' : 'bg-[#14C8CC]'}`}
            style={{ width: `${afterPct}%` }}
          />
        </div>

        <div className="mt-2.5 flex items-baseline justify-between font-mono text-[10.5px] text-[#5A6268] tracking-wider">
          <span>This video</span>
          <span className={overBudget ? 'text-[#E66666]' : 'text-[#ECEAE4]'}>
            {totalCost.toLocaleString()} cr
          </span>
        </div>
        <div className="flex items-baseline justify-between font-mono text-[10.5px] text-[#5A6268] tracking-wider">
          <span>After generate</span>
          <span className={overBudget ? 'text-[#E66666]' : 'text-[#ECEAE4]'}>
            {afterGenerate.toLocaleString()} cr
          </span>
        </div>

        <div className="mt-3 pt-3 border-t border-dashed border-white/10">
          <div className="grid gap-1 mb-1">
            {costItems.map((c, i) => (
              <div key={i} className="flex justify-between text-[11.5px] text-[#8A9198]">
                <span className="truncate pr-2">{c.label}</span>
                <span className="font-mono text-[#ECEAE4] shrink-0">{c.v} cr</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-[9.5px] tracking-[0.14em] uppercase text-[#5A6268]">
            Total
          </span>
          <span className="font-serif text-[22px] font-semibold text-[#14C8CC]">
            {totalCost.toLocaleString()}
            <span className="text-[12px] text-[#8A9198] font-normal ml-1">cr</span>
          </span>
        </div>
        <a
          href="/pricing"
          className="mt-2 block text-center font-mono text-[10px] tracking-wider uppercase text-[#14C8CC] hover:text-[#ECEAE4] transition-colors"
          style={{ textDecoration: 'none' }}
        >
          Top up →
        </a>
      </IntakeField>

      {/* Your setup — voice + caption + style recap */}
      <IntakeField className="p-4">
        <IntakeLabel>Your setup</IntakeLabel>

        {/* Voice row with Play button */}
        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-9 h-9 rounded-full grid place-items-center bg-gradient-to-br from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] font-serif font-semibold text-[14px] shrink-0">
            {prettyVoice(voice).charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-[#ECEAE4] truncate">{prettyVoice(voice)}</div>
            <div className="font-mono text-[9.5px] tracking-wider uppercase text-[#5A6268]">
              {LANGUAGE_LABEL[language] ?? language}
            </div>
          </div>
          <button
            type="button"
            onClick={playVoice}
            disabled={previewLoading}
            className="w-8 h-8 rounded-full grid place-items-center border border-[#14C8CC]/30 text-[#14C8CC] hover:bg-[#14C8CC]/10 transition-colors disabled:opacity-40"
            title={previewPlaying ? 'Stop preview' : 'Play voice'}
          >
            {previewLoading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : previewPlaying
                ? <Square className="w-3 h-3 fill-current" />
                : <Play className="w-3 h-3 fill-current" />}
          </button>
        </div>

        {/* Caption preview */}
        <div className="mb-3">
          <div className="font-mono text-[9.5px] tracking-wider uppercase text-[#5A6268] mb-1.5">
            Captions
          </div>
          <div className="rounded-lg border border-white/5 bg-[#0A0D0F] px-3 py-3 min-h-[56px] flex items-center justify-center">
            {captionStyle === 'none' ? (
              <span className="text-[11.5px] text-[#5A6268] italic">No captions</span>
            ) : (
              <span className={captionCss + ' text-[14px]'}>Your idea in motion</span>
            )}
          </div>
          <div className="mt-1.5">
            {/* Re-use existing selector inline — user can swap style here, live. */}
            <CaptionStyleSelector
              value={captionStyle}
              onChange={() => { /* read-only in the rail; user edits in the main form */ }}
              showLabel={false}
            />
          </div>
        </div>

        {/* Setup recap grid */}
        <div className="grid grid-cols-2 gap-2 text-[11.5px]">
          <div className="rounded-md border border-white/5 bg-[#1B2228] px-2.5 py-1.5">
            <div className="font-mono text-[9px] tracking-wider uppercase text-[#5A6268]">Style</div>
            <div className="text-[#ECEAE4] truncate">{visualStyle.name}</div>
          </div>
          <div className="rounded-md border border-white/5 bg-[#1B2228] px-2.5 py-1.5">
            <div className="font-mono text-[9px] tracking-wider uppercase text-[#5A6268]">Format</div>
            <div className="text-[#ECEAE4]">{aspect}</div>
          </div>
          {duration && (
            <div className="rounded-md border border-white/5 bg-[#1B2228] px-2.5 py-1.5">
              <div className="font-mono text-[9px] tracking-wider uppercase text-[#5A6268]">Length</div>
              <div className="text-[#ECEAE4]">{duration === '>3min' ? '> 3 min' : '< 3 min'}</div>
            </div>
          )}
          <div className="rounded-md border border-white/5 bg-[#1B2228] px-2.5 py-1.5">
            <div className="font-mono text-[9px] tracking-wider uppercase text-[#5A6268]">Mode</div>
            <div className="text-[#ECEAE4] capitalize">{mode === 'doc2video' ? 'Explainer' : mode === 'smartflow' ? 'Smart Flow' : 'Cinematic'}</div>
          </div>
        </div>
      </IntakeField>

      {/* Suggestions */}
      <IntakeField className="p-4">
        <IntakeLabel>Suggestions</IntakeLabel>
        <ul className="grid gap-2">
          {tips.map((t) => {
            const Icon = TIP_ICON[t.icon];
            return (
              <li key={t.id} className="flex items-start gap-2 text-[11.5px] leading-[1.45]">
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${TIP_COLOR[t.icon]}`} />
                <span className="text-[#ECEAE4]/90">{t.body}</span>
              </li>
            );
          })}
        </ul>
      </IntakeField>

      {/* Generate CTA */}
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating || overBudget}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-[14px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {generating
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Play className="w-4 h-4 fill-current" />}
        {generating ? 'Submitting…' : overBudget ? 'Not enough credits' : 'Create Video'}
      </button>
      <div className="text-center font-mono text-[10px] text-[#5A6268] tracking-[0.1em] uppercase -mt-2">
        Delivers to All Projects
      </div>
    </>
  );
}
