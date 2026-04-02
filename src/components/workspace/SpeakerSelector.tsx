import { Mic } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SpeakerVoice =
  // Qwen3 voices (multi-language default)
  | "Nova" | "Atlas" | "Kai" | "Marcus" | "Luna"
  | "Leo" | "Maya" | "Sage" | "Aria"
  // Haitian Creole (Gemini TTS)
  | "Pierre" | "Marie"
  // French (Fish Audio)
  | "Jacques" | "Camille"
  // Spanish (Fish Audio)
  | "Carlos" | "Isabella"
  // English specific (LemonFox / Fish Audio)
  | "Adam" | "River";

interface SpeakerSelectorProps {
  value: SpeakerVoice;
  onChange: (value: SpeakerVoice) => void;
  /** Language code — determines which voices are shown */
  language?: string;
}

interface SpeakerOption { id: SpeakerVoice; label: string; description: string }

const qwenSpeakers: SpeakerOption[] = [
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

const creoleSpeakers: SpeakerOption[] = [
  { id: "Pierre", label: "Pierre", description: "Male" },
  { id: "Marie", label: "Marie", description: "Female" },
];

const frenchSpeakers: SpeakerOption[] = [
  { id: "Jacques", label: "Jacques", description: "Male" },
  { id: "Camille", label: "Camille", description: "Female" },
  ...qwenSpeakers, // Also show Qwen3 voices as options
];

const spanishSpeakers: SpeakerOption[] = [
  { id: "Carlos", label: "Carlos", description: "Male" },
  { id: "Isabella", label: "Isabella", description: "Female" },
  ...qwenSpeakers,
];

const englishSpeakers: SpeakerOption[] = [
  { id: "Adam", label: "Adam", description: "Male" },
  { id: "River", label: "River", description: "Female" },
  ...qwenSpeakers,
];

function getSpeakersForLanguage(language?: string): SpeakerOption[] {
  switch (language) {
    case "ht": return creoleSpeakers;
    case "fr": return frenchSpeakers;
    case "es": return spanishSpeakers;
    case "en": return englishSpeakers;
    default: return qwenSpeakers; // Other languages: Qwen3 only
  }
}

/** Get the default speaker for a language */
export function getDefaultSpeaker(language: string): SpeakerVoice {
  switch (language) {
    case "ht": return "Pierre";
    case "fr": return "Camille";
    case "es": return "Isabella";
    case "en": return "Nova";
    default: return "Nova";
  }
}

export function SpeakerSelector({ value, onChange, language }: SpeakerSelectorProps) {
  const speakers = getSpeakersForLanguage(language);
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
