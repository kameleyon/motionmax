import { useState, useEffect, memo } from "react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { Subtitles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CaptionStyle =
  | "none"
  | "orangeBox"
  | "yellowSlanted"
  | "redSlantedBox"
  | "cyanOutline"
  | "motionBlur"
  | "yellowSmall"
  | "thickStroke"
  | "karaokePop"
  | "typewriter"
  | "neonTeal"
  | "goldLuxury"
  | "bouncyPill"
  | "glitch"
  | "cinematicFade"
  | "redTag"
  | "blackBox"
  | "comicBurst"
  | "retroTerminal"
  | "heavyDropShadow"
  | "cleanPop"
  | "toxicBounce"
  | "proShortForm";

interface CaptionStyleSelectorProps {
  value: CaptionStyle;
  onChange: (value: CaptionStyle) => void;
  /** Show "Captions" label above the dropdown (default true, set false in result pages) */
  showLabel?: boolean;
}

const captionStyles: { id: CaptionStyle; label: string }[] = [
  { id: "none", label: "None" },
  { id: "cleanPop", label: "Clean Pop" },
  { id: "toxicBounce", label: "Toxic Bounce" },
  { id: "proShortForm", label: "Pro Block" },
  { id: "orangeBox", label: "Orange Box" },
  { id: "yellowSlanted", label: "Yellow Slant" },
  { id: "redSlantedBox", label: "Red Slant" },
  { id: "cyanOutline", label: "Cyan Outline" },
  { id: "motionBlur", label: "Motion Blur" },
  { id: "thickStroke", label: "Thick Stroke" },
  { id: "karaokePop", label: "Karaoke" },
  { id: "neonTeal", label: "Neon Teal" },
  { id: "goldLuxury", label: "Gold" },
  { id: "bouncyPill", label: "Pill" },
  { id: "glitch", label: "Glitch" },
  { id: "comicBurst", label: "Comic" },
  { id: "redTag", label: "Red Tag" },
  { id: "blackBox", label: "Black Box" },
  { id: "typewriter", label: "Typewriter" },
  { id: "cinematicFade", label: "Cinematic" },
  { id: "retroTerminal", label: "Terminal" },
  { id: "heavyDropShadow", label: "Shadow" },
  { id: "yellowSmall", label: "Small Yellow" },
];

/**
 * Pro-quality preview CSS using paint-order + -webkit-text-stroke
 * for sharp outlines (not jagged text-shadow). The font-family is
 * applied via inline style (see PREVIEW_FONT_FAMILY) instead of a
 * Tailwind arbitrary value because Tailwind's JIT silently drops
 * comma-containing bracket values like `[font-family:'X',cursive]`
 * in production builds — every preview was falling back to system
 * sans because of it.
 */
export const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  cleanPop: "font-normal text-white uppercase tracking-wide [filter:drop-shadow(0px_2px_3px_rgba(0,0,0,0.6))]",
  toxicBounce: "text-[#39FF14] uppercase tracking-wider [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill] [filter:drop-shadow(0px_3px_0px_#000)]",
  proShortForm: "font-bold text-white uppercase tracking-wider [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill] [filter:drop-shadow(0px_2px_2px_rgba(0,0,0,0.5))]",
  orangeBox: "font-bold text-white bg-[#FF5722] px-1.5 py-0.5 rounded-sm uppercase tracking-wider",
  yellowSlanted: "font-black italic text-[#FFEB3B] uppercase [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill]",
  redSlantedBox: "font-black italic text-white bg-[#E53935] px-2 py-1 uppercase skew-x-[-8deg] rounded-md",
  cyanOutline: "font-black text-[#00BCD4] uppercase [-webkit-text-stroke:1px_#fff] [paint-order:stroke_fill]",
  motionBlur: "font-black text-white uppercase drop-shadow-lg",
  yellowSmall: "font-bold text-[#FFEB3B] uppercase drop-shadow-md",
  thickStroke: "font-black text-white uppercase [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill]",
  karaokePop: "text-white uppercase tracking-[0.15em]",
  neonTeal: "font-bold text-[#00E5FF] uppercase [text-shadow:_0_0_8px_#00E5FF,_0_0_16px_#00E5FF]",
  goldLuxury: "text-[#e3c774] text-base [text-shadow:_1px_1px_2px_#8B6508]",
  bouncyPill: "font-bold text-gray-900 bg-white px-2 py-0.5 rounded-full",
  glitch: "font-black text-white uppercase [text-shadow:_2px_0_#f00,_-2px_0_#00f]",
  comicBurst: "text-[#FFEB3B] uppercase [text-shadow:_2px_2px_0_#E53935,_-1px_-1px_0_#E53935]",
  redTag: "font-bold text-white bg-red-600 px-3 py-1 rounded",
  blackBox: "text-white bg-black/80 px-2 py-0.5",
  typewriter: "font-bold text-green-400 bg-black/50 px-1",
  cinematicFade: "font-light text-white tracking-[0.15em] uppercase",
  retroTerminal: "font-bold text-[#39FF14]",
  heavyDropShadow: "text-white tracking-wider [text-shadow:_3px_3px_0_#000]",
};

/** Font-family per style — applied via inline style for guaranteed
 *  rendering (see previewStyles header for why). Each value is a
 *  proper CSS font-family list with quoted family names + a generic
 *  fallback. The named fonts are loaded in index.html via Google Fonts. */
export const PREVIEW_FONT_FAMILY: Record<CaptionStyle, string> = {
  none: "",
  cleanPop: "'Luckiest Guy', cursive",
  toxicBounce: "'Bangers', cursive",
  proShortForm: "'Oswald', sans-serif",
  orangeBox: "'Comfortaa', cursive",
  yellowSlanted: "'Montserrat', sans-serif",
  redSlantedBox: "'Montserrat', sans-serif",
  cyanOutline: "'Montserrat', sans-serif",
  motionBlur: "'Montserrat', sans-serif",
  yellowSmall: "'Montserrat', sans-serif",
  thickStroke: "'Flavors', cursive",
  karaokePop: "'Rubik Mono One', sans-serif",
  neonTeal: "'Poppins', sans-serif",
  goldLuxury: "'Pangolin', cursive",
  bouncyPill: "'Montserrat', sans-serif",
  glitch: "'Montserrat', sans-serif",
  comicBurst: "'Bangers', cursive",
  redTag: "'Poppins', sans-serif",
  blackBox: "'Special Elite', cursive",
  typewriter: "ui-monospace, 'Courier New', monospace",
  cinematicFade: "'Vina Sans', sans-serif",
  retroTerminal: "ui-monospace, 'Courier New', monospace",
  heavyDropShadow: "'Bebas Neue', sans-serif",
};

// ── Animation per style ──

/** CapCut snap physics */
const snapPhysics = { type: "spring" as const, stiffness: 1200, damping: 30, mass: 0.4 };
const bouncePhysics = { type: "spring" as const, stiffness: 1500, damping: 20, mass: 0.3 };

const styleAnimations: Record<CaptionStyle, Variants> = {
  none: { hidden: { opacity: 0 }, visible: { opacity: 0 } },
  // Spring physics overshoot the filter property into negative blur
  // values (blur(-0.21px) — invalid CSS, console errors). Per-property
  // transition: keep the spring on scale/opacity, but tween the filter
  // so it never overshoots.
  cleanPop: { hidden: { opacity: 0, scale: 0.6, filter: "blur(6px)" }, visible: { opacity: 1, scale: 1, filter: "blur(0px)", transition: { ...snapPhysics, filter: { duration: 0.18, ease: "easeOut" } } } },
  toxicBounce: { hidden: { opacity: 0, scale: 0.1, rotate: -15 }, visible: { opacity: 1, scale: 1, rotate: 0, transition: bouncePhysics } },
  proShortForm: { hidden: { opacity: 0, scale: 0.4, y: 10 }, visible: { opacity: 1, scale: 1, y: 0, transition: snapPhysics } },
  orangeBox: { hidden: { opacity: 0, scale: 0.5 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 400, damping: 15 } } },
  yellowSlanted: { hidden: { opacity: 0, scale: 2, rotate: -10 }, visible: { opacity: 1, scale: 1, rotate: 0, transition: { type: "spring", stiffness: 350, damping: 18 } } },
  redSlantedBox: { hidden: { opacity: 0, x: -30 }, visible: { opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } } },
  cyanOutline: { hidden: { opacity: 0, scale: 0.7 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", bounce: 0.6 } } },
  motionBlur: { hidden: { opacity: 0, x: -60, filter: "blur(12px)" }, visible: { opacity: 1, x: 0, filter: "blur(0px)", transition: { duration: 0.25, ease: "circOut" } } },
  yellowSmall: { hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0, transition: { duration: 0.15 } } },
  thickStroke: { hidden: { opacity: 0, scale: 1.5 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 500, damping: 25 } } },
  karaokePop: { hidden: { opacity: 0.5, scale: 0.9 }, visible: { opacity: 1, scale: 1.15, transition: { type: "spring", stiffness: 400 } } },
  neonTeal: { hidden: { opacity: 0, filter: "brightness(0.4)" }, visible: { opacity: 1, filter: "brightness(1)", transition: { duration: 0.3 } } },
  goldLuxury: { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "backOut" } } },
  bouncyPill: { hidden: { opacity: 0, scale: 0 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", bounce: 0.7 } } },
  glitch: { hidden: { opacity: 0, x: 8, skewX: 15 }, visible: { opacity: 1, x: 0, skewX: 0, transition: { duration: 0.08 } } },
  comicBurst: { hidden: { opacity: 0, scale: 0.2, rotate: -20 }, visible: { opacity: 1, scale: 1.1, rotate: 3, transition: { type: "spring", stiffness: 300, damping: 10 } } },
  redTag: { hidden: { opacity: 0, x: -8 }, visible: { opacity: 1, x: 0, transition: { duration: 0.12 } } },
  blackBox: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.08 } } },
  typewriter: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.04 } } },
  cinematicFade: { hidden: { opacity: 0, filter: "blur(4px)" }, visible: { opacity: 1, filter: "blur(0px)", transition: { duration: 0.5 } } },
  retroTerminal: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.06 } } },
  heavyDropShadow: { hidden: { opacity: 0, y: -15 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 12 } } },
};

/** Single-word pop styles (one word at a time, dead center) */
const SINGLE_WORD_STYLES = new Set<string>([
  "toxicBounce", "proShortForm",
  "orangeBox", "yellowSlanted", "redSlantedBox", "motionBlur",
  "thickStroke", "comicBurst", "heavyDropShadow", "glitch", "bouncyPill",
]);

/** Accumulative styles (words build into a sentence) */
const ACCUMULATE_STYLES = new Set<string>([
  "blackBox", "cinematicFade", "typewriter", "retroTerminal", "cleanPop"
]);

// ── Animated preview row for dropdown ──

const WORDS = ["Your", "idea", "in", "motion"];
const WORD_MS = 450;
const PAUSE_MS = 1200;

const CaptionPreviewRow = memo(function CaptionPreviewRow({ styleId }: { styleId: CaptionStyle }) {
  const [idx, setIdx] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const total = WORDS.length;
    const delay = idx >= total - 1 ? PAUSE_MS : WORD_MS;
    const t = setTimeout(() => {
      if (idx >= total - 1) {
        setCycle(c => c + 1);
        setIdx(0);
      } else {
        setIdx(i => i + 1);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [idx, cycle]);

  const css = previewStyles[styleId];
  const fontFamily = PREVIEW_FONT_FAMILY[styleId];
  const variants = styleAnimations[styleId];
  const isSingle = SINGLE_WORD_STYLES.has(styleId);
  const isAccum = ACCUMULATE_STYLES.has(styleId);

  return (
    <div className="flex items-center justify-center min-h-[32px] w-full gap-1 py-1">
      <AnimatePresence mode="popLayout">
        {WORDS.map((word, i) => {
          // Single-word: only show active word
          if (isSingle && i !== idx) return null;
          // Accumulate: show up to active word
          if (isAccum && i > idx) return null;
          // Karaoke group: show all, highlight active
          if (!isSingle && !isAccum && i > idx) return null;

          // toxicBounce: random neon highlight per word
          const toxicColors = ["#39FF14", "#FFEB3B", "#00E5FF"];
          const wordColor = styleId === "toxicBounce" ? toxicColors[(i + cycle) % toxicColors.length] : undefined;

          return (
            <motion.span
              key={`${word}-${i}-${cycle}`}
              variants={variants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className={cn(
                // Base preview size bumped from 11px → 15px so all
                // caption styles read at a glance in the dropdown.
                // Display fonts (Luckiest Guy / Bangers / Chango)
                // get an extra bump because they're built to be
                // chunky at large sizes — looks anemic small.
                "inline-block leading-tight text-[15px]",
                (styleId === "cleanPop" || styleId === "toxicBounce" || styleId === "comicBurst" || styleId === "thickStroke" || styleId === "heavyDropShadow")
                  ? (word.length <= 4 ? "text-[22px]" : "text-[18px]")
                  : "",
                css,
                !isSingle && !isAccum && i === idx ? "opacity-100" : "",
                !isSingle && !isAccum && i < idx ? "opacity-60" : "",
              )}
              style={{
                fontFamily: fontFamily || undefined,
                ...(wordColor ? { color: wordColor } : {}),
              }}
            >
              {word}
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

// ── Main selector ──

export function CaptionStyleSelector({ value, onChange, showLabel }: CaptionStyleSelectorProps) {
  const selected = captionStyles.find((s) => s.id === value) || captionStyles[0];

  const label = showLabel !== false;

  return (
    <div className={label ? "space-y-1.5" : ""}>
      {label && <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Captions</span>}
      <Select value={value} onValueChange={(v) => onChange(v as CaptionStyle)}>
        <SelectTrigger className={cn("w-auto h-8 text-xs gap-1 px-3")}>
          <SelectValue>
            <span className="flex items-center gap-2 truncate text-xs">
              <Subtitles className="h-3 w-3 shrink-0" />
              {selected.label}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-96 w-[280px] p-1">
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id} className="py-0.5 px-1">
              {s.id === "none" ? (
                <span className="text-xs text-muted-foreground py-1">No captions</span>
              ) : (
                <CaptionPreviewRow styleId={s.id} />
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { captionStyles };
