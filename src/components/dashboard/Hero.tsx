import React, { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export default function Hero() {
  const { user } = useAuth();
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("16:9");
  const [language, setLanguage] = useState("English");

  const { data: profile } = useQuery({
    queryKey: ['hero-profile', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('user_id', user!.id)
        .single();
      return data;
    }
  });
  const suggestions = [
    "Turn my latest blog post into a 9:16 reel",
    "A 60-second history of the Polaroid",
    "Explain compound interest in 45 seconds",
    "Brand teaser with karaoke captions in French"
  ];

  const handleSubmit = () => {
    if (!prompt.trim()) return;
    window.location.href = `/editor?prompt=${encodeURIComponent(prompt)}&ratio=${encodeURIComponent(ratio)}&language=${encodeURIComponent(language)}`;
  };

  return (
    <section className="border border-white/5 rounded-2xl p-[42px_40px_36px] relative overflow-hidden bg-[#10151A]" style={{
      background: `radial-gradient(60% 80% at 85% 10%, rgba(20,200,204,.06), transparent 60%), radial-gradient(55% 70% at 10% 90%, rgba(20,200,204,.14), transparent 60%), #10151A`
    }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        backgroundImage: `linear-gradient(0deg,rgba(255,255,255,.02) 1px,transparent 1px), linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)`,
        backgroundSize: '60px 60px',
        maskImage: 'radial-gradient(70% 70% at 50% 50%,#000,transparent 80%)'
      }}></div>

      <div className="relative flex justify-between items-start gap-5 mb-7">
        <div>
          <h1 className="font-serif font-normal text-[clamp(32px,3.6vw,48px)] leading-[1.02] tracking-tight m-0 mb-1.5 max-w-[22ch]">
            Good evening, {profile?.display_name || user?.email?.split('@')[0] || 'User'}. What are we <em className="not-italic text-[#14C8CC]">making</em>?
          </h1>
          <p className="text-[14px] text-[#8A9198] m-0 mb-6 relative">
            Describe a scene, paste a link, or drop in a document. MotionMax takes it from there.
          </p>
        </div>
        <div className="font-mono text-[11px] tracking-widest uppercase text-[#5A6268]">Mon · Apr 20 · 2026</div>
      </div>

      <form className="relative border border-white/10 rounded-xl bg-[#151B20] p-[16px_16px_12px] flex flex-col gap-3.5 focus-within:border-[#14C8CC] transition-colors" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} 
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          className="w-full bg-transparent border-0 outline-none resize-none text-[#ECEAE4] font-serif text-[22px] leading-[1.35] min-h-[64px] placeholder:text-[#5A6268] placeholder:italic"
          placeholder="A three-minute documentary about the origin of 35mm film, golden-hour Kodak factory, warm serif captions, narrated in my voice…"
        ></textarea>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 p-1 bg-[#1B2228] rounded-lg border border-white/5">
            <button type="button" className="px-3 py-1.5 text-[12px] rounded-md inline-flex items-center gap-1.5 font-sans font-medium bg-[#10151A] text-[#ECEAE4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC]"></span>Cinematic
            </button>
            <button type="button" className="px-3 py-1.5 text-[12px] text-[#8A9198] rounded-md inline-flex items-center gap-1.5 font-sans font-medium hover:text-[#ECEAE4]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#5A6268]"></span>Explainer
            </button>
            <button type="button" className="px-3 py-1.5 text-[12px] text-[#8A9198] rounded-md inline-flex items-center gap-1.5 font-sans font-medium hover:text-[#ECEAE4]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#5A6268]"></span>Smart Flow
            </button>
          </div>
          <button type="button" className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70"><rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h8M8 16h5"></path></svg>
            Attach file
          </button>
          <button type="button" className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path></svg>
            Paste URL
          </button>
          <button type="button" onClick={() => setLanguage(language === 'English' ? 'French' : 'English')} className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a15 15 0 0 1 0 18"></path></svg>
            {language}
          </button>
          <button type="button" onClick={() => setRatio(ratio === '16:9' ? '9:16' : '16:9')} className="font-mono text-[10.5px] text-[#8A9198] px-2.5 py-1 rounded-md border border-white/5 tracking-wider inline-flex items-center gap-1.5 hover:text-[#ECEAE4] hover:border-white/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-70"><rect x="6" y="4" width="12" height="16" rx="2"></rect></svg>
            {ratio}
          </button>
          
          <button type="button" onClick={handleSubmit} className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] border-none">
            Direct <kbd className="font-mono text-[10px] px-1 py-px rounded bg-[#0A0D0F]/35 ml-1">⏎</kbd>
          </button>
        </div>
      </form>

      <div className="flex gap-2 mt-4 flex-wrap relative">
        {suggestions.map((s, i) => (
          <div key={i} onClick={() => setPrompt(s)} className="text-[12.5px] text-[#8A9198] px-3 py-1.5 rounded-full border border-white/5 cursor-pointer transition-colors bg-black/15 hover:text-[#ECEAE4] hover:border-white/10">
            <span className="font-mono text-[10px] text-[#5A6268] mr-1.5 tracking-wider">TRY</span>{s}
          </div>
        ))}
      </div>
    </section>
  );
}