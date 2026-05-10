import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Language = "en" | "fr" | "es" | "ht" | "pt" | "de" | "it" | "nl" | "ru" | "zh" | "ja" | "ko";

interface LanguageSelectorProps {
  value: Language;
  onChange: (value: Language) => void;
}

// C-1-2 (Halo F-A11Y-006 + Compass 1.1 + Tongue 02/03): each row carries
// a BCP-47 `lang` code so screen-reader TTS engines (NVDA, JAWS,
// VoiceOver) switch to the matching synthesizer when reading the native
// script. Without it, "中文" / "日本語" / "Русский" are read phonetically
// using the English voice — gibberish. The `englishName` field powers
// an aria-label that announces the language in plain English for users
// whose AT is configured to stay on a single voice.
const languages: { id: Language; label: string; flag: string; englishName: string }[] = [
  { id: "en", label: "English", flag: "\u{1F1FA}\u{1F1F8}", englishName: "English" },
  { id: "fr", label: "Français", flag: "\u{1F1EB}\u{1F1F7}", englishName: "French" },
  { id: "es", label: "Español", flag: "\u{1F1EA}\u{1F1F8}", englishName: "Spanish" },
  { id: "ht", label: "Kreyòl Ayisyen", flag: "\u{1F1ED}\u{1F1F9}", englishName: "Haitian Creole" },
  // Portuguese removed — Smallest has no native Portuguese voices in v2 or
  // v3.1 and no other provider is wired for PT. The `pt` code stays in the
  // Language union so legacy saved projects still typecheck on load.
  { id: "de", label: "Deutsch", flag: "\u{1F1E9}\u{1F1EA}", englishName: "German" },
  { id: "it", label: "Italiano", flag: "\u{1F1EE}\u{1F1F9}", englishName: "Italian" },
  { id: "nl", label: "Nederlands", flag: "\u{1F1F3}\u{1F1F1}", englishName: "Dutch" },
  { id: "ru", label: "Русский", flag: "\u{1F1F7}\u{1F1FA}", englishName: "Russian" },
  { id: "zh", label: "中文", flag: "\u{1F1E8}\u{1F1F3}", englishName: "Chinese" },
  { id: "ja", label: "日本語", flag: "\u{1F1EF}\u{1F1F5}", englishName: "Japanese" },
  { id: "ko", label: "한국어", flag: "\u{1F1F0}\u{1F1F7}", englishName: "Korean" },
];

export function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  const selected = languages.find((l) => l.id === value) || languages[0];

  return (
    <div className="space-y-2">
      {/* B-NEW-11 (2026-05-10): label clarified from "Language" to
          "Narration language" so users don't mistake this picker for a
          UI-translation switch — the dashboard UI is English-only (no
          i18n runtime); this dropdown selects the voice/TTS language. */}
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
        <Globe className="h-3.5 w-3.5" />
        Narration language
      </h3>
      <Select value={value} onValueChange={(v) => onChange(v as Language)}>
        <SelectTrigger className="w-full sm:w-48">
          <SelectValue>
            {/* The trigger reflects the currently-selected row; tag it with
                lang={selected.id} so AT switches voice when announcing the
                native-script label. The aria-label keeps the English name
                available for users whose AT stays on a single voice. */}
            <span
              className="flex items-center gap-2"
              lang={selected.id}
              aria-label={`${selected.label} (${selected.englishName})`}
            >
              <span aria-hidden="true">{selected.flag}</span>
              <span>{selected.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {languages.map((lang) => (
            // Radix forwards arbitrary props to the underlying option DOM
            // node, so `lang` lands on the focusable list-item. Combined
            // with the per-row `aria-label`, screen readers either switch
            // voice synthesizer to the native-script tongue OR announce
            // the English equivalent — user-mode-dependent, both correct.
            <SelectItem
              key={lang.id}
              value={lang.id}
              lang={lang.id}
              aria-label={`${lang.label} (${lang.englishName})`}
            >
              <span className="flex items-center gap-2">
                <span aria-hidden="true">{lang.flag}</span>
                <span>{lang.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
