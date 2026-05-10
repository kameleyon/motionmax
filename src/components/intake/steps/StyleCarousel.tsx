import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Loader2, Upload, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IntakeLabel } from '../primitives';

// ── Real style preview thumbnails ──
//
// §5 PERF-003 fix (2026-05-10): all 17 thumbs now resolve to WebP first
// with PNG fallback below. cardboard-preview at 1.84 MB → 93 KB. The
// rest collapse 84% on average. Encoded with `ffmpeg -c:v libwebp
// -quality 80 -compression_level 6 -an` from the originals — see
// IntakeForm.tsx for the regen recipe.
//
// C-5-7 (Prism PERF-011): the STYLES array used to live inside
// IntakeForm.tsx. Each entry resolves to its asset URL via
// `new URL(..., import.meta.url)`, which Vite tree-shakes into the
// build but the bytes only download when an `<img src=...>` actually
// requests them. By moving the array (and the carousel JSX that
// consumes it) into its own React.lazy chunk, the 17 URL handles +
// the carousel's framer-motion + scroll ref logic ship in a separate
// JS bundle that only downloads when the form renders.
const STYLES: Array<{ id: string; label: string; preview: string; previewPng: string }> = [
  { id: 'realistic',  label: 'Realistic',   preview: new URL('../../../assets/styles/realistic-preview.webp',  import.meta.url).href, previewPng: new URL('../../../assets/styles/realistic-preview.png',  import.meta.url).href },
  { id: '3d-pixar',   label: '3D Style',    preview: new URL('../../../assets/styles/3d-pixar-preview.webp',   import.meta.url).href, previewPng: new URL('../../../assets/styles/3d-pixar-preview.png',   import.meta.url).href },
  { id: 'anime',      label: 'Anime',       preview: new URL('../../../assets/styles/anime-preview.webp',      import.meta.url).href, previewPng: new URL('../../../assets/styles/anime-preview.png',      import.meta.url).href },
  { id: 'claymation', label: 'Claymation',  preview: new URL('../../../assets/styles/claymation-preview.webp', import.meta.url).href, previewPng: new URL('../../../assets/styles/claymation-preview.png', import.meta.url).href },
  { id: 'storybook',  label: 'Storybook',   preview: new URL('../../../assets/styles/painterly-preview.webp',  import.meta.url).href, previewPng: new URL('../../../assets/styles/painterly-preview.png',  import.meta.url).href },
  { id: 'caricature', label: 'Caricature',  preview: new URL('../../../assets/styles/caricature-preview.webp', import.meta.url).href, previewPng: new URL('../../../assets/styles/caricature-preview.png', import.meta.url).href },
  { id: 'doodle',     label: 'Urban Doodle',preview: new URL('../../../assets/styles/doodle-preview.webp',     import.meta.url).href, previewPng: new URL('../../../assets/styles/doodle-preview.png',     import.meta.url).href },
  { id: 'stick',      label: 'Stick Figure',preview: new URL('../../../assets/styles/stick-preview.webp',      import.meta.url).href, previewPng: new URL('../../../assets/styles/stick-preview.png',      import.meta.url).href },
  { id: 'sketch',     label: 'Papercut 3D', preview: new URL('../../../assets/styles/sketch-preview.webp',     import.meta.url).href, previewPng: new URL('../../../assets/styles/sketch-preview.png',     import.meta.url).href },
  { id: 'crayon',     label: 'Crayon',      preview: new URL('../../../assets/styles/crayon-preview.webp',     import.meta.url).href, previewPng: new URL('../../../assets/styles/crayon-preview.png',     import.meta.url).href },
  { id: 'minimalist', label: 'Minimalist',  preview: new URL('../../../assets/styles/minimalist-preview.webp', import.meta.url).href, previewPng: new URL('../../../assets/styles/minimalist-preview.png', import.meta.url).href },
  { id: 'moody',      label: 'Moody',       preview: new URL('../../../assets/styles/moody-preview.webp',      import.meta.url).href, previewPng: new URL('../../../assets/styles/moody-preview.png',      import.meta.url).href },
  { id: 'chalkboard', label: 'Chalkboard',  preview: new URL('../../../assets/styles/chalkboard-preview.webp', import.meta.url).href, previewPng: new URL('../../../assets/styles/chalkboard-preview.png', import.meta.url).href },
  { id: 'lego',       label: 'LEGO',        preview: new URL('../../../assets/styles/lego-preview.webp',       import.meta.url).href, previewPng: new URL('../../../assets/styles/lego-preview.png',       import.meta.url).href },
  { id: 'cardboard',  label: 'Cardboard',   preview: new URL('../../../assets/styles/cardboard-preview.webp',  import.meta.url).href, previewPng: new URL('../../../assets/styles/cardboard-preview.png',  import.meta.url).href },
  { id: 'babie',      label: 'Babie',       preview: new URL('../../../assets/styles/barbie-preview.webp',     import.meta.url).href, previewPng: new URL('../../../assets/styles/barbie-preview.png',     import.meta.url).href },
  { id: 'custom',     label: 'Custom',      preview: new URL('../../../assets/styles/custom-preview.webp',     import.meta.url).href, previewPng: new URL('../../../assets/styles/custom-preview.png',     import.meta.url).href },
];

/** The label shown in the IntakeRail summary chip — exposed so the
 *  parent IntakeForm can resolve a styleId to its display label without
 *  importing the STYLES array (which would defeat the lazy-loading). */
export function styleLabelFor(styleId: string): string {
  return STYLES.find((s) => s.id === styleId)?.label ?? 'Style';
}

export interface StyleCarouselProps {
  styleId: string;
  onStyleChange: (id: string) => void;
  customStyle: string;
  onCustomStyleChange: (v: string) => void;
  customStyleImage: string | null;
  onCustomStyleImageChange: (v: string | null) => void;
  uploadingStyle: boolean;
  onCustomStyleImageUpload: (file: File | null) => void | Promise<void>;
}

export default function StyleCarousel({
  styleId,
  onStyleChange,
  customStyle,
  onCustomStyleChange,
  customStyleImage,
  onCustomStyleImageChange,
  uploadingStyle,
  onCustomStyleImageUpload,
}: StyleCarouselProps) {
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

  const selectedStyle = STYLES.find((s) => s.id === styleId);

  return (
    <div>
      <IntakeLabel>Visual style</IntakeLabel>
      <div className="relative">
        <button
          type="button"
          onClick={() => scrollBy('left')}
          className={cn(
            'absolute left-0 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full grid place-items-center border border-white/10 bg-[#0A0D0F]/90 backdrop-blur-sm text-[#ECEAE4] hover:bg-[#151B20] transition-opacity',
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
            'absolute right-0 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full grid place-items-center border border-white/10 bg-[#0A0D0F]/90 backdrop-blur-sm text-[#ECEAE4] hover:bg-[#151B20] transition-opacity',
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
              onClick={() => onStyleChange(s.id)}
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
                {/* §5 PERF-003 fix (2026-05-10): WebP-first <picture>
                    with PNG fallback for the few browsers that don't
                    decode WebP. loading=lazy + decoding=async + size
                    hints keep the fetch off the critical path. */}
                <picture>
                  <source srcSet={s.preview} type="image/webp" />
                  <img
                    src={s.previewPng}
                    alt={s.label}
                    loading="lazy"
                    decoding="async"
                    width={256}
                    height={192}
                    className="w-full h-full object-cover"
                  />
                </picture>
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
            onChange={(e) => onCustomStyleChange(e.target.value)}
            placeholder="Describe your custom visual style…"
            className="w-full bg-[#151B20] border border-white/5 rounded-lg px-3 py-2.5 text-base sm:text-[13px] text-[#ECEAE4] outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]/60 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0A0D0F] focus:border-[#14C8CC]/50 placeholder:text-[#5A6268]"
          />
          {customStyleImage ? (
            <div className="relative inline-block">
              <img src={customStyleImage} alt="Style reference" className="h-24 rounded-lg border border-white/10" />
              <button
                type="button"
                onClick={() => onCustomStyleImageChange(null)}
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
                onChange={(e) => onCustomStyleImageUpload(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
