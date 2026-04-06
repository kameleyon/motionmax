import { useState, useEffect, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
}

const captionStyles: { id: CaptionStyle; label: string }[] = [
  { id: "none", label: "None" },
  { id: "cleanPop", label: "Clean Pop" },
  { id: "toxicBounce", label: "Toxic Bounce" },
  { id: "proShortForm", label: "Pro Block" },
  { id: "orangeBox", label: "Orange Box" },
  { id: "yellowSlanted", label: "Yellow Slant" },
  { id: "redSlantedBox", label: "Red Slant" },
  { id: "cyanOutline", label: "Cyan" },
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

/** Preview CSS for each style -- scaled down for the grid squares */
export const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  cleanPop: "font-black text-white uppercase drop-shadow-lg",
  toxicBounce: "font-black text-[#39FF14] uppercase [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill]",
  proShortForm: "font-black text-white uppercase [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill]",
  orangeBox: "font-black text-white bg-[#FF5722] px-1 rounded-sm uppercase",
  yellowSlanted: "font-black italic text-[#FFEB3B] uppercase [text-shadow:_-1px_-1px_0_#000,_1px_1px_0_#000]",
  redSlantedBox: "font-black italic text-white bg-[#E53935] px-1 uppercase skew-x-[-8deg]",
  cyanOutline: "font-black text-[#00BCD4] uppercase [text-shadow:_-1px_-1px_0_#fff,_1px_1px_0_#fff]",
  motionBlur: "font-black text-white uppercase drop-shadow-md",
  thickStroke: "font-black text-white uppercase [-webkit-text-stroke:2px_#000] [paint-order:stroke_fill]",
  karaokePop: "font-black text-white uppercase",
  neonTeal: "font-bold text-[#00E5FF] uppercase [text-shadow:_0_0_6px_#00E5FF]",
  goldLuxury: "[font-family:'Pacifico',cursive] italic text-[#FFD700] [text-shadow:_1px_1px_1px_#8B6508]",
  bouncyPill: "font-bold text-gray-900 bg-white px-1.5 py-0.5 rounded-full",
  glitch: "font-black text-white uppercase [text-shadow:_1px_0_#f00,_-1px_0_#00f]",
  comicBurst: "[font-family:'Bangers',cursive] text-[#FFEB3B] uppercase [text-shadow:_1px_1px_0_#E53935]",
  redTag: "font-bold text-white bg-red-600 px-1 py-0.5",
  blackBox: "font-medium text-white bg-black/80 px-1 py-0.5",
  typewriter: "font-mono font-bold text-green-400 bg-black/50 px-0.5",
  cinematicFade: "font-light text-white tracking-[0.1em] uppercase",
  retroTerminal: "font-mono font-bold text-[#39FF14]",
  heavyDropShadow: "[font-family:'Bebas_Neue',sans-serif] text-white tracking-wider [text-shadow:_2px_2px_0_#000]",
  yellowSmall: "font-bold text-[#FFEB3B] uppercase drop-shadow-sm",
};

const WORDS = ["Your", "idea", "in", "motion"];
const WORD_MS = 500;
const PAUSE_MS = 1200;

const CaptionPreviewLine = memo(function CaptionPreviewLine({ styleId }: { styleId: CaptionStyle }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const delay = idx >= WORDS.length ? PAUSE_MS : WORD_MS;
    const t = setTimeout(() => setIdx(prev => prev >= WORDS.length ? 0 : prev + 1), delay);
    return () => clearTimeout(t);
  }, [idx]);

  const css = previewStyles[styleId];

  return (
    <div className="flex items-center justify-center gap-1 py-1 min-h-[28px] w-full">
      <AnimatePresence mode="popLayout">
        {WORDS.slice(0, idx + 1).map((word, i) => (
          <motion.span
            key={`${word}-${i}`}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: i === idx ? 1 : 0.7, scale: i === idx ? 1.05 : 1 }}
            transition={{ type: "spring", stiffness: 600, damping: 25, mass: 0.5 }}
            className={cn("inline-block text-[11px] leading-none", css)}
          >
            {word}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
});

export function CaptionStyleSelector({ value, onChange }: CaptionStyleSelectorProps) {
  const selected = captionStyles.find((s) => s.id === value) || captionStyles[0];

  return (
    <div className="space-y-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Captions</span>
      <Select value={value} onValueChange={(v) => onChange(v as CaptionStyle)}>
        <SelectTrigger className={cn("w-auto h-8 text-xs gap-1 px-3")}>
          <SelectValue>
            <span className="flex items-center gap-2 truncate text-xs">
              <Subtitles className="h-3 w-3 shrink-0" />
              {selected.label}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-96 w-[300px] p-1">
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id} className="py-0.5 px-1">
              {s.id === "none" ? (
                <span className="text-xs text-muted-foreground py-1">No captions</span>
              ) : (
                <CaptionPreviewLine styleId={s.id} />
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { captionStyles };
