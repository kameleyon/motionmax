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
  | "classic" | "bold" | "neon" | "karaoke" | "minimal" | "box"
  | "typewriter" | "gradient" | "subtitleBar" | "outlineOnly" | "shadowPop"
  | "handwritten" | "topCenter" | "allCapsGlow"
  | "whiteStroke" | "blueStroke" | "redFire" | "orangeGlow"
  | "yellowOutline" | "greenPill" | "goldScript" | "comicPop"
  | "blueWhite" | "redBlack" | "yellowRed"
  | "yellowHighlight" | "redTag" | "chunkyBlue" | "dualTone" | "purpleNeon";

interface CaptionStyleSelectorProps {
  value: CaptionStyle;
  onChange: (value: CaptionStyle) => void;
}

const captionStyles: { id: CaptionStyle; label: string; description: string }[] = [
  { id: "none", label: "None", description: "No captions" },
  // Core
  { id: "classic", label: "Classic", description: "White, black outline" },
  { id: "bold", label: "Bold", description: "Large uppercase" },
  { id: "neon", label: "Neon", description: "Aqua glow" },
  { id: "karaoke", label: "Karaoke", description: "Word-by-word" },
  { id: "minimal", label: "Minimal", description: "Small, subtle" },
  { id: "box", label: "Box", description: "Aqua rectangle" },
  // Text effects
  { id: "typewriter", label: "Typewriter", description: "Monospace" },
  { id: "gradient", label: "Gradient", description: "Aqua to gold" },
  { id: "subtitleBar", label: "Subtitle Bar", description: "Dark bar" },
  { id: "outlineOnly", label: "Outline Only", description: "No fill" },
  { id: "shadowPop", label: "Shadow Pop", description: "Heavy shadow" },
  { id: "handwritten", label: "Handwritten", description: "Script font" },
  { id: "topCenter", label: "Top Center", description: "Top position" },
  { id: "allCapsGlow", label: "All Caps Glow", description: "Uppercase glow" },
  // Colorful
  { id: "whiteStroke", label: "White Stroke", description: "Thick black border" },
  { id: "blueStroke", label: "Blue Stroke", description: "Blue, white border" },
  { id: "redFire", label: "Red Fire", description: "Red, yellow border" },
  { id: "orangeGlow", label: "Orange Glow", description: "Orange, white glow" },
  { id: "yellowOutline", label: "Yellow Outline", description: "Yellow border" },
  { id: "greenPill", label: "Green Pill", description: "Green badge" },
  { id: "goldScript", label: "Gold Script", description: "Elegant gold" },
  { id: "comicPop", label: "Comic Pop", description: "Red, yellow burst" },
  { id: "blueWhite", label: "Blue White", description: "Blue outline" },
  { id: "redBlack", label: "Red Black", description: "Red, black outline" },
  { id: "yellowRed", label: "Yellow Red", description: "Yellow, red border" },
  // Premium / Trending
  { id: "yellowHighlight", label: "Yellow Highlight", description: "Gold keyword pop" },
  { id: "redTag", label: "Red Tag", description: "Red box on word" },
  { id: "chunkyBlue", label: "Chunky Blue", description: "Soft periwinkle" },
  { id: "dualTone", label: "Dual Tone", description: "White + indigo" },
  { id: "purpleNeon", label: "Purple Neon", description: "Purple glow" },
];

/** CSS preview classes that mimic the ASS styles */
export const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  // Core
  classic: "text-white font-bold text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0),_-1px_-1px_2px_rgb(0_0_0)]",
  bold: "text-white font-black text-base uppercase [text-shadow:_2px_2px_4px_rgb(0_0_0)]",
  neon: "text-primary font-bold text-sm bg-black/60 px-1.5 py-0.5 rounded",
  karaoke: "text-white font-bold text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0)]",
  minimal: "text-gray-400 text-xs",
  box: "text-white font-bold text-sm bg-primary/40 px-2 py-0.5 rounded-md border border-primary/30",
  // Text effects
  typewriter: "text-white font-mono text-sm bg-black/50 px-1.5 py-0.5",
  gradient: "font-black text-sm bg-gradient-to-r from-primary to-yellow-400 bg-clip-text text-transparent",
  subtitleBar: "text-white text-sm bg-black/70 px-4 py-1 w-full text-center",
  outlineOnly: "text-transparent font-black text-sm [-webkit-text-stroke:_1px_white]",
  shadowPop: "text-white font-black text-sm [text-shadow:_3px_3px_0px_rgba(0,0,0,0.5)]",
  handwritten: "text-white text-sm italic [text-shadow:_1px_1px_2px_rgb(0_0_0)]",
  topCenter: "text-white font-bold text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0)]",
  allCapsGlow: "text-white font-black text-sm uppercase [text-shadow:_0_0_8px_rgb(17_196_208)]",
  // Colorful
  whiteStroke: "text-white font-black text-sm [text-shadow:_2px_2px_0_rgb(0_0_0),_-2px_-2px_0_rgb(0_0_0),_2px_-2px_0_rgb(0_0_0),_-2px_2px_0_rgb(0_0_0)]",
  blueStroke: "text-blue-500 font-black text-sm [text-shadow:_2px_2px_0_white,_-2px_-2px_0_white,_2px_-2px_0_white,_-2px_2px_0_white]",
  redFire: "text-red-500 font-black text-sm [text-shadow:_2px_2px_0_rgb(234_196_53),_-1px_-1px_0_rgb(234_196_53)]",
  orangeGlow: "text-orange-500 font-black text-sm [text-shadow:_2px_2px_0_white,_-1px_-1px_0_white,_0_0_8px_white]",
  yellowOutline: "text-white font-black text-sm [text-shadow:_2px_2px_0_rgb(234_196_53),_-2px_-2px_0_rgb(234_196_53),_2px_-2px_0_rgb(234_196_53),_-2px_2px_0_rgb(234_196_53)]",
  greenPill: "text-white font-bold text-sm bg-green-600 px-3 py-1 rounded-full",
  goldScript: "text-yellow-600 italic text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0)]",
  comicPop: "text-red-600 font-black text-sm uppercase bg-yellow-400 px-2 py-0.5 rounded [text-shadow:_1px_1px_0_rgb(0_0_0)]",
  blueWhite: "text-white font-black text-sm [text-shadow:_2px_2px_0_rgb(48_96_224),_-2px_-2px_0_rgb(48_96_224),_2px_-2px_0_rgb(48_96_224),_-2px_2px_0_rgb(48_96_224)]",
  redBlack: "text-red-500 font-black text-sm [text-shadow:_2px_2px_0_rgb(0_0_0),_-2px_-2px_0_rgb(0_0_0),_2px_-2px_0_rgb(0_0_0),_-2px_2px_0_rgb(0_0_0)]",
  yellowRed: "text-yellow-400 font-black text-sm [text-shadow:_2px_2px_0_rgb(224_48_48),_-2px_-2px_0_rgb(224_48_48),_2px_-2px_0_rgb(224_48_48),_-2px_2px_0_rgb(224_48_48)]",
  // Premium / Trending
  yellowHighlight: "text-white font-black text-base uppercase [text-shadow:_2px_2px_0_rgb(0_0_0),_-2px_-2px_0_rgb(0_0_0)] [&]:decoration-yellow-400",
  redTag: "text-white text-sm lowercase bg-red-600 px-2 py-0.5 rounded",
  chunkyBlue: "text-indigo-400 font-black text-base [text-shadow:_3px_3px_0_rgb(60_60_120),_-1px_-1px_0_rgb(60_60_120)]",
  dualTone: "text-white font-bold text-sm [text-shadow:_2px_2px_0_rgb(68_68_160),_-2px_-2px_0_rgb(68_68_160)]",
  purpleNeon: "text-purple-400 font-bold text-sm [text-shadow:_0_0_8px_rgb(168_85_247),_0_0_20px_rgb(168_85_247)]",
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
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue>
            <span className="flex items-center gap-2">
              {selected.id !== "none" && (
                <span className={`inline-block ${previewStyles[selected.id]}`}>Aa</span>
              )}
              <span>{selected.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex items-center gap-3">
                {s.id !== "none" ? (
                  <span className={`inline-block w-10 text-center ${previewStyles[s.id]}`}>Aa</span>
                ) : (
                  <span className="inline-block w-10 text-center text-muted-foreground text-xs">---</span>
                )}
                <span className="flex flex-col">
                  <span className="font-medium text-sm">{s.label}</span>
                  <span className="text-muted-foreground text-xs">{s.description}</span>
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
