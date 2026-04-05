import { useState, useEffect, memo } from "react";
import { Subtitles } from "lucide-react";
import { motion, AnimatePresence, type Variants } from "framer-motion";
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
}

const captionStyles: { id: CaptionStyle; label: string }[] = [
  { id: "none", label: "None" },
  { id: "orangeBox", label: "Orange Box" },
  { id: "yellowSlanted", label: "Yellow Slanted" },
  { id: "redSlantedBox", label: "Red Slanted" },
  { id: "cyanOutline", label: "Cyan Outline" },
  { id: "motionBlur", label: "Motion Blur" },
  { id: "yellowSmall", label: "Small Yellow" },
  { id: "thickStroke", label: "Thick Stroke" },
  { id: "karaokePop", label: "Karaoke Pop" },
  { id: "neonTeal", label: "Neon Teal" },
  { id: "goldLuxury", label: "Gold Luxury" },
  { id: "bouncyPill", label: "Bouncy Pill" },
  { id: "glitch", label: "Glitch Offset" },
  { id: "comicBurst", label: "Comic Burst" },
  { id: "redTag", label: "Red Tag" },
  { id: "blackBox", label: "Black Box" },
  { id: "typewriter", label: "Typewriter" },
  { id: "cinematicFade", label: "Cinematic Fade" },
  { id: "retroTerminal", label: "Retro Terminal" },
  { id: "heavyDropShadow", label: "Heavy Shadow" },
  { id: "cleanPop", label: "Clean Pop" },
  { id: "toxicBounce", label: "Toxic Bounce" },
  { id: "proShortForm", label: "Pro Short Form" },
];

/** CSS classes for each style (scaled down for dropdown) */
export const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  orangeBox: "[font-family:'Montserrat',sans-serif] font-black text-white bg-[#FF5722] px-1.5 py-0.5 rounded-sm uppercase text-[10px] tracking-wider",
  yellowSlanted: "[font-family:'Montserrat',sans-serif] font-black italic text-[#FFEB3B] uppercase text-[10px] tracking-widest [text-shadow:_-1px_-1px_0_#000,_1px_-1px_0_#000,_-1px_1px_0_#000,_1px_1px_0_#000]",
  redSlantedBox: "[font-family:'Montserrat',sans-serif] font-black italic text-white bg-[#E53935] px-1.5 py-0.5 uppercase text-[10px] tracking-wide skew-x-[-8deg]",
  cyanOutline: "[font-family:'Montserrat',sans-serif] font-black text-[#00BCD4] uppercase text-[10px] tracking-wider [text-shadow:_-1px_-1px_0_#fff,_1px_-1px_0_#fff,_-1px_1px_0_#fff,_1px_1px_0_#fff]",
  motionBlur: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-[10px] tracking-widest drop-shadow-md",
  yellowSmall: "[font-family:'Montserrat',sans-serif] font-bold text-[#FFEB3B] text-[9px] uppercase tracking-widest drop-shadow-sm",
  thickStroke: "[font-family:'Poppins',sans-serif] font-black text-white uppercase text-[10px] tracking-wide [text-shadow:_-2px_-2px_0_#000,_2px_-2px_0_#000,_-2px_2px_0_#000,_2px_2px_0_#000]",
  karaokePop: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-[10px]",
  neonTeal: "[font-family:'Poppins',sans-serif] font-bold text-[#00E5FF] uppercase text-[10px] tracking-widest [text-shadow:_0_0_6px_#00E5FF,_0_0_12px_#00E5FF]",
  goldLuxury: "[font-family:'Pacifico',cursive] italic text-[#FFD700] text-[10px] tracking-wider [text-shadow:_1px_1px_1px_#8B6508]",
  bouncyPill: "[font-family:'Montserrat',sans-serif] font-bold text-gray-900 bg-white px-2 py-0.5 rounded-full text-[9px]",
  glitch: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-[10px] tracking-widest [text-shadow:_1px_0_0_#ff0000,_-1px_0_0_#0000ff]",
  comicBurst: "[font-family:'Bangers',cursive] text-[#FFEB3B] text-[11px] uppercase tracking-wide [text-shadow:_1px_1px_0_#E53935,_-1px_-1px_0_#E53935]",
  redTag: "[font-family:'Poppins',sans-serif] font-bold text-white bg-red-600 px-1.5 py-0.5 text-[9px]",
  blackBox: "[font-family:'Helvetica',sans-serif] font-medium text-white bg-black/80 px-1.5 py-0.5 text-[9px]",
  typewriter: "font-mono font-bold text-green-400 bg-black/50 px-1 text-[9px]",
  cinematicFade: "[font-family:'Montserrat',sans-serif] font-light text-white tracking-[0.15em] uppercase text-[9px]",
  retroTerminal: "font-mono font-bold text-[#39FF14] text-[9px]",
  heavyDropShadow: "[font-family:'Bebas_Neue',sans-serif] text-white text-[11px] tracking-wider [text-shadow:_2px_2px_0_#000]",
  cleanPop: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-[10px] tracking-wide [filter:drop-shadow(0px_2px_2px_rgba(0,0,0,0.6))]",
  toxicBounce: "[font-family:'Montserrat',sans-serif] font-black text-[#39FF14] uppercase text-[10px] tracking-wider [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill] [filter:drop-shadow(0px_3px_0px_#000)]",
  proShortForm: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-[10px] tracking-wider [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill] [filter:drop-shadow(0px_1px_2px_rgba(0,0,0,0.5))]",
};

/** Animation variants — smooth and steady for dropdown preview */
const styleVariants: Record<CaptionStyle, Variants> = {
  none: { hidden: { opacity: 0 }, visible: { opacity: 0 } },
  orangeBox: { hidden: { opacity: 0, scale: 0.85 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.25, ease: "easeOut" } } },
  yellowSlanted: { hidden: { opacity: 0, scale: 1.2 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: "easeOut" } } },
  redSlantedBox: { hidden: { opacity: 0, x: -10 }, visible: { opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } } },
  cyanOutline: { hidden: { opacity: 0, scale: 0.85 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: "easeOut" } } },
  motionBlur: { hidden: { opacity: 0, x: -15 }, visible: { opacity: 1, x: 0, transition: { duration: 0.25, ease: "easeOut" } } },
  yellowSmall: { hidden: { opacity: 0, y: 3 }, visible: { opacity: 1, y: 0, transition: { duration: 0.2 } } },
  thickStroke: { hidden: { opacity: 0, scale: 1.1 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.25, ease: "easeOut" } } },
  karaokePop: { hidden: { opacity: 0.5, scale: 0.95 }, visible: { opacity: 1, scale: 1.05, transition: { duration: 0.3, ease: "easeOut" } } },
  neonTeal: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.35 } } },
  goldLuxury: { hidden: { opacity: 0, y: 4 }, visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } } },
  bouncyPill: { hidden: { opacity: 0, scale: 0.7 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 200, damping: 20 } } },
  glitch: { hidden: { opacity: 0, x: 3 }, visible: { opacity: 1, x: 0, transition: { duration: 0.1 } } },
  comicBurst: { hidden: { opacity: 0, scale: 0.7 }, visible: { opacity: 1, scale: 1, transition: { duration: 0.3, ease: "backOut" } } },
  redTag: { hidden: { opacity: 0, x: -5 }, visible: { opacity: 1, x: 0, transition: { duration: 0.2 } } },
  blackBox: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.15 } } },
  typewriter: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.08 } } },
  cinematicFade: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.6 } } },
  retroTerminal: { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.1 } } },
  heavyDropShadow: { hidden: { opacity: 0, y: -6 }, visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } } },
  cleanPop: { hidden: { opacity: 0, scale: 0.6 }, visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 800, damping: 25, mass: 0.5 } } },
  toxicBounce: { hidden: { opacity: 0, scale: 0.2, rotate: -8 }, visible: { opacity: 1, scale: 1, rotate: 0, transition: { type: "spring", stiffness: 1000, damping: 18, mass: 0.4 } } },
  proShortForm: { hidden: { opacity: 0, scale: 0.4, y: 8 }, visible: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 800, damping: 25, mass: 0.5 } } },
};

const PREVIEW_WORDS = ["Your", "idea", "in", "motion"];
const WORD_MS = 600;

/** Animated preview row for a single caption style in the dropdown */
const CaptionPreviewRow = memo(function CaptionPreviewRow({ styleId }: { styleId: CaptionStyle }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIdx((prev) => {
        if (prev >= PREVIEW_WORDS.length - 1) {
          setTimeout(() => setCycle((c) => c + 1), 600);
          return 0;
        }
        return prev + 1;
      });
    }, WORD_MS);
    return () => clearInterval(timer);
  }, [cycle]);

  const css = previewStyles[styleId];
  const variants = styleVariants[styleId];

  // Single-word pop styles
  const isSingleWord = [
    "orangeBox", "yellowSlanted", "redSlantedBox", "motionBlur",
    "thickStroke", "comicBurst", "heavyDropShadow", "glitch",
    "bouncyPill", "cleanPop", "toxicBounce",
  ].includes(styleId);

  return (
    <div className="flex items-center justify-center h-6 w-full overflow-hidden">
      <AnimatePresence mode="popLayout">
        {PREVIEW_WORDS.map((word, idx) => {
          if (isSingleWord && idx !== activeIdx) return null;
          if (!isSingleWord && idx > activeIdx) return null;

          return (
            <motion.span
              key={`${word}-${idx}-${cycle}`}
              variants={variants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              className={`inline-block mx-0.5 ${css}`}
            >
              {word}
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

export function CaptionStyleSelector({ value, onChange }: CaptionStyleSelectorProps) {
  const selected = captionStyles.find((s) => s.id === value) || captionStyles[0];

  return (
    <div>
      <Select value={value} onValueChange={(v) => onChange(v as CaptionStyle)}>
        <SelectTrigger className="w-auto h-8 text-xs gap-1 px-3">
          <SelectValue>
            <span className="flex items-center gap-2 truncate text-xs">
              <Subtitles className="h-3 w-3 shrink-0" />
              {selected.label}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-80 w-[280px]">
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id} className="py-1.5">
              {s.id === "none" ? (
                <span className="text-xs text-muted-foreground">No captions</span>
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
