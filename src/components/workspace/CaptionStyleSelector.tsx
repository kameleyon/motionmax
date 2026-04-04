import { Subtitles } from "lucide-react";
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
  | "heavyDropShadow";

interface CaptionStyleSelectorProps {
  value: CaptionStyle;
  onChange: (value: CaptionStyle) => void;
}

const captionStyles: { id: CaptionStyle; label: string; description: string }[] = [
  { id: "none", label: "None", description: "No captions" },
  // From Reference Visuals
  { id: "orangeBox", label: "Orange Box", description: "White text, orange background" },
  { id: "yellowSlanted", label: "Yellow Slanted", description: "Heavy italic, thick black outline" },
  { id: "redSlantedBox", label: "Red Slanted", description: "White text, red italic box" },
  { id: "cyanOutline", label: "Cyan Outline", description: "Cyan text, white outline" },
  { id: "motionBlur", label: "Motion Blur", description: "White text, high-speed blur entry" },
  { id: "yellowSmall", label: "Small Yellow", description: "Minimalist yellow text" },
  // Trending / Premium
  { id: "thickStroke", label: "Thick Stroke", description: "White text, heavy black border" },
  { id: "karaokePop", label: "Karaoke Pop", description: "Word-by-word dynamic scale" },
  { id: "neonTeal", label: "Neon Teal", description: "Aqua/Teal glowing text" },
  { id: "goldLuxury", label: "Gold Luxury", description: "Elegant gold metallic look" },
  { id: "bouncyPill", label: "Bouncy Pill", description: "Text inside a rounded pill" },
  { id: "glitch", label: "Glitch Offset", description: "RGB split shift effect" },
  { id: "comicBurst", label: "Comic Burst", description: "Explosive superhero style" },
  { id: "redTag", label: "Red Tag", description: "High-contrast red highlight" },
  { id: "blackBox", label: "Classic Black Box", description: "Documentary style" },
  { id: "typewriter", label: "Typewriter", description: "Monospace rigid entry" },
  { id: "cinematicFade", label: "Cinematic Fade", description: "Slow elegant reveal" },
  { id: "retroTerminal", label: "Retro Terminal", description: "Green pixel font" },
  { id: "heavyDropShadow", label: "Heavy Shadow", description: "Thick diagonal shadow" },
];

/** CSS preview classes that mimic the specific template styles */
export const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  // Reference Visuals
  orangeBox: "[font-family:'Montserrat',sans-serif] font-black text-white bg-[#FF5722] px-2 py-0.5 rounded-sm uppercase tracking-wider",
  yellowSlanted: "[font-family:'Montserrat',sans-serif] font-black italic text-[#FFEB3B] uppercase tracking-widest [text-shadow:_-2px_-2px_0_#000,_2px_-2px_0_#000,_-2px_2px_0_#000,_2px_2px_0_#000,_4px_4px_0_#000]",
  redSlantedBox: "[font-family:'Montserrat',sans-serif] font-black italic text-white bg-[#E53935] px-2 py-0.5 uppercase tracking-wide skew-x-[-10deg]",
  cyanOutline: "[font-family:'Montserrat',sans-serif] font-black text-[#00BCD4] uppercase tracking-wider [text-shadow:_-2px_-2px_0_#fff,_2px_-2px_0_#fff,_-2px_2px_0_#fff,_2px_2px_0_#fff]",
  motionBlur: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase tracking-widest drop-shadow-lg",
  yellowSmall: "[font-family:'Montserrat',sans-serif] font-bold text-[#FFEB3B] text-xs uppercase tracking-widest drop-shadow-md",
  // Trending / Premium
  thickStroke: "[font-family:'Poppins',sans-serif] font-black text-white uppercase tracking-wide [text-shadow:_-3px_-3px_0_#000,_3px_-3px_0_#000,_-3px_3px_0_#000,_3px_3px_0_#000]",
  karaokePop: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase text-shadow-md",
  neonTeal: "[font-family:'Poppins',sans-serif] font-bold text-[#00E5FF] uppercase tracking-widest [text-shadow:_0_0_10px_#00E5FF,_0_0_20px_#00E5FF]",
  goldLuxury: "[font-family:'Pacifico',cursive] font-bold italic text-[#FFD700] tracking-wider [text-shadow:_1px_1px_2px_#8B6508]",
  bouncyPill: "[font-family:'Montserrat',sans-serif] font-bold text-gray-900 bg-white px-3 py-1 rounded-full text-sm",
  glitch: "[font-family:'Montserrat',sans-serif] font-black text-white uppercase tracking-widest [text-shadow:_2px_0_0_#ff0000,_-2px_0_0_#0000ff]",
  comicBurst: "[font-family:'Bangers',cursive] text-[#FFEB3B] text-xl uppercase tracking-wide [text-shadow:_2px_2px_0_#E53935,_-1px_-1px_0_#E53935]",
  redTag: "[font-family:'Poppins',sans-serif] font-bold text-white bg-red-600 px-1.5 py-0.5 text-sm shadow-sm",
  blackBox: "[font-family:'Helvetica',sans-serif] font-medium text-white bg-black/80 px-2 py-1 text-sm",
  typewriter: "font-mono font-bold text-green-400 bg-black/50 px-1",
  cinematicFade: "[font-family:'Montserrat',sans-serif] font-light text-white tracking-[0.2em] uppercase",
  retroTerminal: "font-mono font-bold text-[#39FF14] text-sm",
  heavyDropShadow: "[font-family:'Bebas_Neue',sans-serif] text-white text-lg tracking-wider [text-shadow:_4px_4px_0_#000]",
};

export function CaptionStyleSelector({ value, onChange }: CaptionStyleSelectorProps) {
  const selected = captionStyles.find((s) => s.id === value) || captionStyles[0];

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
        <Subtitles className="h-3.5 w-3.5" />
        Captions
      </h3>
      <Select value={value} onValueChange={(v) => onChange(v as CaptionStyle)}>
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue>
            <span className="flex items-center gap-2 truncate">
              {selected.id !== "none" && (
                <span className={`inline-block ${previewStyles[selected.id]}`}>Aa</span>
              )}
              <span>{selected.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex items-center gap-3">
                {s.id !== "none" ? (
                  <span className={`inline-block w-12 text-center ${previewStyles[s.id]}`}>Aa</span>
                ) : (
                  <span className="inline-block w-12 text-center text-muted-foreground text-xs">---</span>
                )}
                <span className="flex flex-col">
                  <span className="font-medium text-sm">{s.label}</span>
                  <span className="text-muted-foreground text-[10px]">{s.description}</span>
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { captionStyles };
