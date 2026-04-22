import { Play, Loader2 } from 'lucide-react';
import { IntakeField, IntakeLabel } from './primitives';
import type { IntakeAspect } from './types';

export type PreviewThumbnailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

export type StoryboardScene = { title: string; description: string };
export type StoryboardState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; scenes: StoryboardScene[] }
  | { status: 'error'; message: string };

/** Right-rail content: aspect-aware Live Preview (real AI thumbnail),
 *  text-based Storyboard peek (real scene titles from a cheap LLM
 *  call), cost breakdown, and Generate CTA. */
export default function IntakeRail({
  aspect, prompt, visualStyle, camera, grade, costItems, totalCost,
  creditsAvailable, onGenerate, generating,
  thumbnail, storyboard,
}: {
  aspect: IntakeAspect;
  prompt: string;
  visualStyle: { name: string; bg: string };
  camera?: string;
  grade?: string;
  costItems: Array<{ label: string; v: number }>;
  totalCost: number;
  creditsAvailable: number;
  onGenerate: () => void;
  generating?: boolean;
  thumbnail: PreviewThumbnailState;
  storyboard: StoryboardState;
}) {
  const aspectCss = aspect.replace(':', '/');
  const previewWidthPct = aspect === '16:9' ? 80 : 45;

  const thumbReady = thumbnail.status === 'ready';
  const thumbLoading = thumbnail.status === 'loading';

  return (
    <>
      {/* Live preview */}
      <IntakeField className="p-4">
        <IntakeLabel>
          Live preview
          {thumbLoading && <Loader2 className="w-3 h-3 animate-spin text-[#14C8CC] ml-auto" />}
        </IntakeLabel>
        <div
          className="h-[180px] sm:h-[200px] bg-[#050709] rounded-lg relative overflow-hidden border border-white/5"
          style={{ display: 'grid', placeItems: 'center' }}
        >
          <div
            className="rounded-[3px] relative overflow-hidden transition-[width,aspect-ratio] duration-300"
            style={{
              width: `${previewWidthPct}%`,
              aspectRatio: aspectCss,
              background: thumbReady ? '#050709' : visualStyle.bg,
              boxShadow: '0 20px 40px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)',
            }}
          >
            {thumbReady ? (
              <img
                src={thumbnail.url}
                alt="AI preview"
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div
                className="absolute inset-0"
                style={{ background: 'radial-gradient(60% 60% at 50% 50%, rgba(20,200,204,.35), transparent 60%)' }}
              />
            )}
            <div
              className="absolute bottom-1.5 left-0 right-0 text-center font-serif font-semibold px-[10%]"
              style={{ fontSize: 9, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,.9)' }}
            >
              {prompt.trim() ? prompt.trim().slice(0, 40) : 'Your caption preview…'}
            </div>
          </div>
        </div>
        <div className="flex justify-between mt-2.5 font-mono text-[10px] text-[#5A6268] tracking-wider">
          <span>
            {aspect} · {visualStyle.name}
            {thumbnail.status === 'error' && ' · preview failed'}
            {thumbnail.status === 'idle' && prompt.trim().length < 10 && ' · type more to preview'}
          </span>
          <span>{camera ? `${camera} · ` : ''}{(grade ?? '').slice(0, 14)}</span>
        </div>
      </IntakeField>

      {/* Storyboard peek — real scene titles when available */}
      <IntakeField className="p-4">
        <div className="flex items-center justify-between mb-2.5">
          <IntakeLabel>
            Storyboard · {storyboard.status === 'ready' ? `${storyboard.scenes.length} scenes` : 'preview'}
            {storyboard.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin text-[#14C8CC] ml-2" />}
          </IntakeLabel>
          {storyboard.status === 'ready' && (
            <button type="button" className="font-mono text-[10px] text-[#14C8CC] tracking-wider hover:text-[#ECEAE4] transition-colors">
              EDIT →
            </button>
          )}
        </div>

        {storyboard.status === 'ready' ? (
          <div className="grid grid-cols-2 gap-1.5">
            {storyboard.scenes.slice(0, 8).map((scene, i) => (
              <div
                key={i}
                className="rounded-md border border-white/5 bg-[#1B2228] p-2 relative overflow-hidden"
                style={{ aspectRatio: aspectCss, minHeight: 68 }}
              >
                <div className="absolute top-1 left-1.5 font-mono text-[8px] text-[#14C8CC] tracking-wider">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div className="h-full flex flex-col justify-end">
                  <div className="font-serif text-[11px] text-[#ECEAE4] leading-[1.15] mb-0.5 line-clamp-2">
                    {scene.title}
                  </div>
                  <div className="font-mono text-[8.5px] text-[#5A6268] leading-[1.25] line-clamp-2">
                    {scene.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="rounded-[3px] border border-white/5 relative overflow-hidden"
                style={{
                  aspectRatio: aspectCss,
                  background: `linear-gradient(135deg, hsl(${i * 40 + 180} 40% 30%), hsl(${i * 40 + 200} 50% 12%))`,
                }}
              >
                <div className="absolute top-1 left-1.5 font-mono text-[8px] text-white/70 tracking-wider">
                  {String(i + 1).padStart(2, '0')}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 font-serif italic text-[11.5px] text-[#8A9198] leading-[1.4]">
          {storyboard.status === 'ready'
            ? 'Draft outline · final scenes refined during generation'
            : storyboard.status === 'error'
              ? `Couldn't build storyboard: ${storyboard.message}`
              : storyboard.status === 'idle' && prompt.trim().length < 10
                ? 'Describe your video to generate a storyboard outline'
                : 'Building outline from your prompt…'}
        </div>
      </IntakeField>

      {/* Cost breakdown */}
      <IntakeField className="p-4">
        <IntakeLabel>Generation cost</IntakeLabel>
        <div className="grid gap-1.5 mb-3">
          {costItems.map((c, i) => (
            <div key={i} className="flex justify-between text-[12px] text-[#8A9198]">
              <span>{c.label}</span>
              <span className="font-mono text-[#ECEAE4]">{c.v} cr</span>
            </div>
          ))}
        </div>
        <div className="border-t border-dashed border-white/10 pt-2.5 flex justify-between items-baseline">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268]">Total</span>
          <span className="font-serif text-[22px] font-semibold text-[#14C8CC]">
            {totalCost} <span className="text-[12px] text-[#8A9198] font-normal">cr</span>
          </span>
        </div>
        <div className="mt-1.5 font-mono text-[9.5px] text-[#5A6268] tracking-[0.08em] text-right uppercase">
          {creditsAvailable.toLocaleString()} available
        </div>
      </IntakeField>

      {/* Generate CTA */}
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating}
        className="w-full inline-flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl text-[14px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {generating
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : <Play className="w-4 h-4 fill-current" />}
        {generating ? 'Submitting…' : 'Create Video'}
      </button>
      <div className="text-center font-mono text-[10px] text-[#5A6268] tracking-[0.1em] uppercase -mt-2">
        Delivers to All Projects
      </div>
    </>
  );
}
