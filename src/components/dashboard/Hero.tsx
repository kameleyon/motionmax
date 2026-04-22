import { useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

type ProjectMode = 'cinematic' | 'doc2video' | 'smartflow';
type Language = 'en' | 'fr' | 'es' | 'ht' | 'de' | 'it' | 'nl';
type AspectRatio = '16:9' | '9:16' | '1:1';

const LANGUAGE_LABEL: Record<Language, string> = {
  en: 'English', fr: 'Français', es: 'Español', ht: 'Kreyòl',
  de: 'Deutsch', it: 'Italiano', nl: 'Nederlands',
};

const MODE_PILLS: Array<{ id: ProjectMode; label: string }> = [
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'doc2video', label: 'Explainer' },
  { id: 'smartflow', label: 'Smart Flow' },
];

const SUGGESTIONS = [
  'Turn my latest blog post into a 9:16 reel',
  'A 60-second history of the Polaroid',
  'Explain compound interest in 45 seconds',
  'Brand teaser with karaoke captions in French',
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
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [aspectMenuOpen, setAspectMenuOpen] = useState(false);

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
    ? `/app/create?mode=${mode}&lang=${language}&format=${aspect === '9:16' ? 'portrait' : aspect === '1:1' ? 'square' : 'landscape'}&prompt=${encodeURIComponent(prompt.trim())}`
    : '#';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
      e.preventDefault();
      window.location.href = submitHref;
    }
  };

  return (
    <section
      className="border border-white/5 rounded-2xl p-[42px_40px_36px] relative overflow-hidden bg-[#10151A]"
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

      <div className="relative flex justify-between items-start gap-5 mb-7">
        <div>
          <h1 className="font-serif font-normal text-[clamp(32px,3.6vw,48px)] leading-[1.02] tracking-tight m-0 mb-1.5 max-w-[22ch]">
            {greeting}, {displayName}. What are we <em className="not-italic text-[#14C8CC]">making</em>?
          </h1>
          <p className="text-[14px] text-[#8A9198] m-0 mb-6 relative">
            Describe a scene, paste a link, or drop in a document. MotionMax takes it from there.
          </p>
        </div>
        <div className="font-mono text-[11px] tracking-widest uppercase text-[#5A6268]">{todayLabel}</div>
      </div>

      <form
        className="relative border border-white/10 rounded-xl bg-[#151B20] p-[16px_16px_12px] flex flex-col gap-3.5 focus-within:border-[#14C8CC] transition-colors"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) window.location.href = submitHref;
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent border-0 outline-none resize-none text-[#ECEAE4] font-serif text-[22px] leading-[1.35] min-h-[64px] placeholder:text-[#5A6268] placeholder:italic"
          placeholder="A three-minute documentary about the origin of 35mm film, golden-hour Kodak factory, warm serif captions, narrated in my voice…"
        />

        <div className="flex items-center gap-2 flex-wrap">
          {/* Mode pills */}
          <div className="flex gap-1 p-1 bg-[#1B2228] rounded-lg border border-white/5">
            {MODE_PILLS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={
                  'px-3 py-1.5 text-[12px] rounded-md inline-flex items-center gap-1.5 font-sans font-medium transition-colors ' +
                  (mode === m.id
                    ? 'bg-[#10151A] text-[#ECEAE4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                    : 'text-[#8A9198] hover:text-[#ECEAE4]')
                }
              >
                <span className={`w-1.5 h-1.5 rounded-full ${mode === m.id ? 'bg-[#14C8CC]' : 'bg-[#5A6268]'}`} />
                {m.label}
              </button>
            ))}
          </div>

          {/* Language */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setLangMenuOpen((v) => !v); setAspectMenuOpen(false); }}
              className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a15 15 0 0 1 0 18" />
              </svg>
              {LANGUAGE_LABEL[language]}
            </button>
            {langMenuOpen && (
              <div className="absolute z-20 top-full left-0 mt-1 bg-[#10151A] border border-white/10 rounded-lg p-1 min-w-[140px] shadow-xl">
                {(Object.entries(LANGUAGE_LABEL) as [Language, string][]).map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => { setLanguage(code); setLangMenuOpen(false); }}
                    className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors ${language === code ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#ECEAE4] hover:bg-white/5'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Aspect ratio */}
          <div className="relative">
            <button
              type="button"
              onClick={() => { setAspectMenuOpen((v) => !v); setLangMenuOpen(false); }}
              className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70">
                <rect x="6" y="4" width="12" height="16" rx="2" />
              </svg>
              {aspect}
            </button>
            {aspectMenuOpen && (
              <div className="absolute z-20 top-full left-0 mt-1 bg-[#10151A] border border-white/10 rounded-lg p-1 min-w-[100px] shadow-xl">
                {(['16:9', '9:16', '1:1'] as AspectRatio[]).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => { setAspect(a); setAspectMenuOpen(false); }}
                    className={`w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors ${aspect === a ? 'bg-[#14C8CC]/10 text-[#14C8CC]' : 'text-[#ECEAE4] hover:bg-white/5'}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            )}
          </div>

          <a
            href={submitHref}
            onClick={(e) => { if (!canSubmit) e.preventDefault(); }}
            aria-disabled={!canSubmit}
            className={
              'ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold transition-all ' +
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

      <div className="flex gap-2 mt-4 flex-wrap relative">
        {SUGGESTIONS.map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setPrompt(s)}
            className="text-[12.5px] text-[#8A9198] px-3 py-1.5 rounded-full border border-white/5 cursor-pointer transition-colors bg-black/15 hover:text-[#ECEAE4] hover:border-white/10"
          >
            <span className="font-mono text-[10px] text-[#5A6268] mr-1.5 tracking-wider">TRY</span>
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}
