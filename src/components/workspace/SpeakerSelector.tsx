import { Mic } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SpeakerVoice =
  | "Nova" | "Atlas" | "Kai" | "Marcus" | "Luna"
  | "Leo" | "Maya" | "Sage" | "Aria";

interface SpeakerSelectorProps {
  value: SpeakerVoice;
  onChange: (value: SpeakerVoice) => void;
}

const speakers: { id: SpeakerVoice; label: string; description: string }[] = [
  { id: "Nova", label: "Nova", description: "Warm female" },
  { id: "Aria", label: "Aria", description: "Expressive female" },
  { id: "Luna", label: "Luna", description: "Gentle female" },
  { id: "Maya", label: "Maya", description: "Bright female" },
  { id: "Atlas", label: "Atlas", description: "Deep male" },
  { id: "Kai", label: "Kai", description: "Smooth male" },
  { id: "Marcus", label: "Marcus", description: "Confident male" },
  { id: "Leo", label: "Leo", description: "Energetic male" },
  { id: "Sage", label: "Sage", description: "Mature male" },
];

export function SpeakerSelector({ value, onChange }: SpeakerSelectorProps) {
  const selected = speakers.find((s) => s.id === value) || speakers[0];

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
        <Mic className="h-3.5 w-3.5" />
        Voice
      </h3>
      <Select value={value} onValueChange={(v) => onChange(v as SpeakerVoice)}>
        <SelectTrigger className="w-full sm:w-48">
          <SelectValue>
            <span className="flex items-center gap-2">
              <span className="font-medium">{selected.label}</span>
              <span className="text-muted-foreground text-xs">{selected.description}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {speakers.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex items-center gap-2">
                <span className="font-medium">{s.label}</span>
                <span className="text-muted-foreground text-xs">{s.description}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
