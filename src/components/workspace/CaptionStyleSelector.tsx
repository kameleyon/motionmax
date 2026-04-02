import { Subtitles } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CaptionStyle = "none" | "classic" | "bold" | "neon" | "karaoke" | "minimal" | "box";

interface CaptionStyleSelectorProps {
  value: CaptionStyle;
  onChange: (value: CaptionStyle) => void;
}

const captionStyles: { id: CaptionStyle; label: string; description: string; preview: string }[] = [
  { id: "none", label: "None", description: "No captions", preview: "" },
  { id: "classic", label: "Classic", description: "White text, black outline", preview: "Aa" },
  { id: "bold", label: "Bold", description: "Large uppercase", preview: "AA" },
  { id: "neon", label: "Neon", description: "Aqua glow", preview: "Aa" },
  { id: "karaoke", label: "Karaoke", description: "Word-by-word", preview: "A a" },
  { id: "minimal", label: "Minimal", description: "Small, subtle", preview: "Aa" },
  { id: "box", label: "Box", description: "Colored rectangle", preview: "Aa" },
];

/** CSS preview classes that mimic the ASS styles */
const previewStyles: Record<CaptionStyle, string> = {
  none: "",
  classic: "text-white font-bold text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0),_-1px_-1px_2px_rgb(0_0_0)]",
  bold: "text-white font-black text-base uppercase [text-shadow:_2px_2px_4px_rgb(0_0_0)]",
  neon: "text-primary font-bold text-sm bg-black/60 px-1.5 py-0.5 rounded",
  karaoke: "text-white font-bold text-sm [text-shadow:_1px_1px_2px_rgb(0_0_0)]",
  minimal: "text-gray-400 text-xs",
  box: "text-white font-bold text-sm bg-primary/40 px-2 py-0.5 rounded-md border border-primary/30",
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
        <SelectTrigger className="w-full sm:w-52">
          <SelectValue>
            <span className="flex items-center gap-2">
              <span>{selected.label}</span>
              <span className="text-muted-foreground text-xs">{selected.description}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {captionStyles.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex items-center gap-3">
                {s.preview && (
                  <span className={`inline-block w-8 text-center ${previewStyles[s.id]}`}>
                    {s.preview}
                  </span>
                )}
                <span className="flex flex-col">
                  <span className="font-medium">{s.label}</span>
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

/** CSS preview for caption styles — used in edit panel preview */
export { previewStyles, captionStyles };
