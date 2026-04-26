import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import {
  getDefaultSpeaker,
  getSpeakersForLanguage,
  type SpeakerVoice,
} from '@/components/workspace/SpeakerSelector';

type ProjectMode = 'cinematic' | 'doc2video' | 'smartflow';
type Language = 'en' | 'fr' | 'es' | 'ht' | 'de' | 'it' | 'nl';
type AspectRatio = '16:9' | '9:16';

function prettyVoiceLabel(id: string, fallback: string): string {
  const stripped = id.replace(/^(sm2?|gm):/i, '');
  return fallback || (stripped.charAt(0).toUpperCase() + stripped.slice(1));
}

const LANGUAGE_LABEL: Record<Language, string> = {
  en: 'English', fr: 'Français', es: 'Español', ht: 'Kreyòl',
  de: 'Deutsch', it: 'Italiano', nl: 'Nederlands',
};

const MODE_PILLS: Array<{ id: ProjectMode; label: string }> = [
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'doc2video', label: 'Explainer' },
  { id: 'smartflow', label: 'Smart Flow' },
];

// Keep this short — the row is display-width-limited on mobile and
// MotionMax doesn't offer variable durations (scenes are ~10s each,
// total length is mode-bound). So no "60-second" or "45 seconds"
// phrasing here.
const SUGGESTIONS = [
  'Turn my blog post into a reel',
  'The history of the Polaroid',
  'Brand teaser for tiktok in French',
];

function greetingFor(hour: number): string {
  if (hour < 5)  return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Late night creative session';
}

export default function Hero() {
  const { user } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<ProjectMode>('cinematic');
  const [language, setLanguage] = useState<Language>('en');
  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [voice, setVoice] = useState<SpeakerVoice>('Adam');
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);

  const speakersForLang = useMemo(() => getSpeakersForLanguage(language), [language]);
  const currentSpeaker = speakersForLang.find((s) => s.id === voice) ?? speakersForLang[0];

  useEffect(() => {
    if (!speakersForLang.some((s) => s.id === voice)) {
      setVoice(getDefaultSpeaker(language));
    }
  }, [language, speakersForLang, voice]);

  // Keyboard / outside-click dismissal for the three menus. Without
  // this, opened menus trapped focus and could only be closed by
  // selecting an item, which fails WCAG 2.1.2 (no keyboard trap) and
  // 2.1.4 (consistent dismissal). Escape closes the open menu and
  // returns focus to its trigger; an outside click closes silently.
  const langTriggerRef = useRef<HTMLButtonElement | null>(null);
  const voiceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const aspectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const langMenuRef = useRef<HTMLDivElement | null>(null);
  const voiceMenuRef = useRef<HTMLDivElement | null>(null);
  const aspectMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!langMenuOpen && !voiceMenuOpen && !aspectMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (langMenuOpen)   { setLangMenuOpen(false);   langTriggerRef.current?.focus(); }
      if (voiceMenuOpen)  { setVoiceMenuOpen(false);  voiceTriggerRef.current?.focus(); }
      if (aspectMenuOpen) { setAspectMenuOpen(false); aspectTriggerRef.current?.focus(); }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      const inLang   = !!langMenuRef.current?.contains(t)   || !!langTriggerRef.current?.contains(t);
      const inVoice  = !!voiceMenuRef.current?.contains(t)  || !!voiceTriggerRef.current?.contains(t);
      const inAspect = !!aspectMenuRef.current?.contains(t) || !!aspectTriggerRef.current?.contains(t);
      if (langMenuOpen   && !inLang)   setLangMenuOpen(false);
      if (voiceMenuOpen  && !inVoice)  setVoiceMenuOpen(false);
      if (aspectMenuOpen && !inAspect) setAspectMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [langMenuOpen, voiceMenuOpen, aspectMenuOpen]);

  const { data: profile } = useQuery({
    queryKey: ['hero-profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data;
    },
  });

  // Refresh greeting + date on mount; cheap enough.
  const { greeting, todayLabel } = useMemo(() => {
    const now = new Date();
    return {
      greeting: greetingFor(now.getHours()),
      todayLabel: format(now, 'EEE · MMM d · yyyy').toUpperCase(),
    };
  }, []);

  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'there';
  const canSubmit = prompt.trim().length > 5;

  const submitHref = canSubmit
    ? `/app/create/new?mode=${mode}&lang=${language}&format=${aspect === '9:16' ? 'portrait' : 'landscape'}&voice=${encodeURIComponent(voice)}&prompt=${encodeURIComponent(prompt.trim())}`
    : '#';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
      e.preventDefault();
      window.location.href = submitHref;
    }
  };

  return (
    <section
      className="border border-white/5 rounded-2xl p-5 sm:p-8 md:p-10 lg:p-[42px_40px_36px] relative overflow-hidden bg-[#10151A]"
      style={{
        background: `radial-gradient(60% 80% at 85% 10%, rgba(20,200,204,.06), transparent 60%), radial-gradient(55% 70% at 10% 90%, rgba(20,200,204,.14), transparent 60%), #10151A`,
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(0deg,rgba(255,255,255,.02) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)`,
          backgroundSize: '60px 60px',
          maskImage: 'radial-gradient(70% 70% at 50% 50%,#000,transparent 80%)',
        }}
      />

      <div className="relative flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3 sm:gap-5 mb-5 sm:mb-7">
        <div className="flex-1 min-w-0">
          <h1 className="font-serif font-normal text-[clamp(24px,6vw,48px)] leading-[1.05] tracking-tight m-0 mb-1.5 max-w-[22ch]">
            {greeting}, {displayName}. What are we <em className="not-italic text-[#14C8CC]">making</em>?
          </h1>
          <p className="text-[13px] sm:text-[14px] text-[#8A9198] m-0 mb-4 sm:mb-6 relative">
            Describe a scene, paste a link, or drop in a document. MotionMax takes it from there.
          </p>
        </div>
        <div className="font-mono text-[10px] sm:text-[11px] tracking-widest uppercase text-[#5A6268] shrink-0">{todayLabel}</div>
      </div>

      <form
        className="relative border border-white/10 rounded-xl bg-[#151B20] p-3 sm:p-[16px_16px_12px] flex flex-col gap-3.5 focus-within:border-[#14C8CC] transition-colors"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) window.location.href = submitHref;
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent border-0 outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] rounded-sm resize-none text-[#ECEAE4] font-serif text-[16px] sm:text-[19px] md:text-[22px] leading-[1.35] min-h-[80px] sm:min-h-[96px] placeholder:text-[#5A6268]"
          placeholder="A three-minute documentary about the origin of 35mm film, golden-hour Kodak factory, warm serif captions, narrated in my voice…"
        />

        <div className="flex flex-col gap-3">
          {/* Mode pills — no horizontal scroll on mobile. Equal-flex
              pills at small widths so they share the row evenly; tight
              padding so Smart Flow fits. */}
          <div className="flex p-[3px] bg-[#1B2228] rounded-lg border border-white/5 w-full sm:w-auto sm:self-start">
            {MODE_PILLS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={
                  'flex-1 sm:flex-initial px-1.5 sm:px-3 py-1.5 text-[11px] sm:text-[12px] rounded-md inline-flex items-center justify-center gap-1 sm:gap-1.5 font-sans font-medium transition-colors whitespace-nowrap ' +
                  (mode === m.id
                    ? 'bg-[#10151A] text-[#ECEAE4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                    : 'text-[#8A9198] hover:text-[#ECEAE4]')
                }
              >
                <span className={`w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full ${mode === m.id ? 'bg-[#14C8CC]' : 'bg-[#5A6268]'}`} />
                {m.label}
              </button>
            ))}
          </div>

          {/* Dropdown row — wraps on mobile, sits inline on ≥sm. */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Language */}
              <div className="relative">
                <button
                  ref={langTriggerRef}
                  type="button"
                  onClick={() => { setLangMenuOpen((v) => !v); setAspectMenuOpen(false); setVoiceMenuOpen(false); }}
                  aria-haspopup="listbox"
                  aria-expanded={langMenuOpen}
                  aria-controls="hero-lang-menu"
                  aria-label={`Language: ${LANGUAGE_LABEL[language]}`}
                  className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F]"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a15 15 0 0 1 0 18" />
                  </svg>
                  {LANGUAGE_LABEL[language]}
                </button>
                {langMenuOpen && (
                  <div
                    ref={langMenuRef}
                    id="hero-lang-menu"
                    role="listbox"
                    aria-label="Language"
                    className="absolute z-20 top-full left-0 mt-1 bg-[#10151A] border border-white/10 rounded-lg p-1 min-w-[140px] shadow-xl"
                  >
                    {(Object.entries(LANGUAGE_LABEL) as [Language, string][]).map(([code, label]) => (
                      <button
                        key={code}
                        type="button"
                        role="option"
                        aria-selected={language === code}
                        onClick={() => { setLanguage(code); setLangMenuOpen(false); langTriggerRef.current?.focus(); }}
                        className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 ${language === code ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#ECEAE4] hover:bg-white/5'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Speaker */}
              <div className="relative">
                <button
                  ref={voiceTriggerRef}
                  type="button"
                  onClick={() => { setVoiceMenuOpen((v) => !v); setLangMenuOpen(false); setAspectMenuOpen(false); }}
                  aria-haspopup="listbox"
                  aria-expanded={voiceMenuOpen}
                  aria-controls="hero-voice-menu"
                  aria-label={`Voice: ${prettyVoiceLabel(voice, currentSpeaker?.label ?? 'Voice')}`}
                  className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F]"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="13" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                  {prettyVoiceLabel(voice, currentSpeaker?.label ?? 'Voice')}
                </button>
                {voiceMenuOpen && (
                  <div
                    ref={voiceMenuRef}
                    id="hero-voice-menu"
                    role="listbox"
                    aria-label="Voice"
                    className="absolute z-20 top-full left-0 mt-1 bg-[#10151A] border border-white/10 rounded-lg p-1 min-w-[180px] max-h-[240px] overflow-y-auto shadow-xl"
                  >
                    {speakersForLang.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        role="option"
                        aria-selected={voice === s.id}
                        onClick={() => { setVoice(s.id); setVoiceMenuOpen(false); voiceTriggerRef.current?.focus(); }}
                        className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 ${voice === s.id ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#ECEAE4] hover:bg-white/5'}`}
                      >
                        <span className="font-medium">{s.label}</span>
                        <span className="text-[#5A6268] text-[10.5px] ml-auto">{s.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Aspect ratio */}
              <div className="relative">
                <button
                  ref={aspectTriggerRef}
                  type="button"
                  onClick={() => { setAspectMenuOpen((v) => !v); setLangMenuOpen(false); setVoiceMenuOpen(false); }}
                  aria-haspopup="listbox"
                  aria-expanded={aspectMenuOpen}
                  aria-controls="hero-aspect-menu"
                  aria-label={`Aspect ratio: ${aspect}`}
                  className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F]"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70" aria-hidden="true">
                    <rect x="6" y="4" width="12" height="16" rx="2" />
                  </svg>
                  {aspect}
                </button>
                {aspectMenuOpen && (
                  <div
                    ref={aspectMenuRef}
                    id="hero-aspect-menu"
                    role="listbox"
                    aria-label="Aspect ratio"
                    className="absolute z-20 top-full left-0 mt-1 bg-[#10151A] border border-white/10 rounded-lg p-1 min-w-[100px] shadow-xl"
                  >
                    {(['16:9', '9:16'] as AspectRatio[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        role="option"
                        aria-selected={aspect === a}
                        onClick={() => { setAspect(a); setAspectMenuOpen(false); aspectTriggerRef.current?.focus(); }}
                        className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 ${aspect === a ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#ECEAE4] hover:bg-white/5'}`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <a
            href={submitHref}
            onClick={(e) => { if (!canSubmit) e.preventDefault(); }}
            aria-disabled={!canSubmit}
            className={
              'w-full justify-center inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ' +
              (canSubmit
                ? 'text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]'
                : 'text-[#5A6268] bg-[#1B2228] border border-white/5 cursor-not-allowed')
            }
            style={{ textDecoration: 'none' }}
          >
            Direct
            <kbd className={`font-mono text-[10px] px-1 py-px rounded ml-1 ${canSubmit ? 'bg-[#0A0D0F]/35' : 'bg-white/5'}`}>⏎</kbd>
          </a>
        </div>
      </form>

      {/* Suggestions — wrap (no scrollbar) and only 3 items, so the
          row breathes on mobile without horizontal scroll. */}
      <div className="flex flex-wrap gap-2 mt-4 relative">
        {SUGGESTIONS.map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setPrompt(s)}
            className="text-[11px] text-[#8A9198] px-2.5 py-1.5 rounded-full border border-white/5 cursor-pointer transition-colors bg-black/15 hover:text-[#ECEAE4] hover:border-white/10"
          >
            <span className="font-mono text-[10px] text-[#5A6268] mr-1.5 tracking-wider">TRY</span>
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}
