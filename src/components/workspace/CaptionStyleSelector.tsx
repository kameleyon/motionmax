import { Subtitles } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function CaptionStyleSelector({ value, onChange }: CaptionStyleSelectorProps) {
  return (
    <div className="space-y-2 w-full overflow-hidden">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1.5">
        <Subtitles className="h-3 w-3" />
        Captions
      </h3>

      {/* Horizontal scrollable grid -- CapCut style */}
      <div className="flex w-full overflow-x-auto pb-2 gap-2 snap-x scrollbar-thin scrollbar-thumb-border/50">
        {captionStyles.map((s) => {
          const isSelected = value === s.id;

          return (
            <button
              key={s.id}
              onClick={() => onChange(s.id)}
              className={cn(
                "relative flex flex-col items-center justify-center w-[72px] h-[72px] shrink-0 snap-start rounded-lg border transition-all overflow-hidden",
                isSelected
                  ? "border-primary ring-1 ring-primary"
                  : "border-border/30 hover:border-border/60",
              )}
            >
              {/* Preview square */}
              <div className="flex-1 w-full flex items-center justify-center bg-gray-950/70">
                {s.id !== "none" ? (
                  <span className={`inline-block text-[10px] leading-none ${previewStyles[s.id]}`}>
                    Aa
                  </span>
                ) : (
                  <span className="text-muted-foreground/30 text-[10px]">--</span>
                )}
              </div>

              {/* Label */}
              <div className="h-5 w-full flex items-center justify-center bg-background/80 border-t border-border/20">
                <span className="text-[8px] font-medium truncate px-0.5 text-muted-foreground">{s.label}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { captionStyles };
