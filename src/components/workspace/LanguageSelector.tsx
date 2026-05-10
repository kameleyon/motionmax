import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSpeakersForLanguage } from "./SpeakerSelector";

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
//
// C-3-6 (Wave 6): voice-catalog truth.
//   - `available: false` hides the locale from the picker entirely (no
//     working voices wired in the worker for this locale).
//   - `quality: 'stable' | 'beta'` lets the UI surface a quality chip.
//     Beta = the worker routes through Gemini Flash multilingual but
//     the locale wasn't part of the original native-voice roster, so
//     prosody / accent fidelity may vary on first listen.
//
// Today every locale below DOES have a working route via Gemini Flash
// 2.5 (see worker/src/services/audioRouter.ts — case 3 is "anything
// else → Google Gemini TTS" for all 11 languages). The audit's claim
// that RU/ZH/JA/KO/DE/IT were "unimplemented" was stale by the time
// Wave 5 landed. We mark those six as 'beta' so users get an honest
// expectation chip; English / French / Spanish / Haitian Creole /
// Dutch stay 'stable' as part of the original tested roster.
type Quality = "stable" | "beta";
const languages: {
  id: Language;
  label: string;
  flag: string;
  englishName: string;
  available: boolean;
  quality: Quality;
}[] = [
  { id: "en", label: "English", flag: "\u{1F1FA}\u{1F1F8}", englishName: "English", available: true, quality: "stable" },
  { id: "fr", label: "Français", flag: "\u{1F1EB}\u{1F1F7}", englishName: "French", available: true, quality: "stable" },
  { id: "es", label: "Español", flag: "\u{1F1EA}\u{1F1F8}", englishName: "Spanish", available: true, quality: "stable" },
  { id: "ht", label: "Kreyòl Ayisyen", flag: "\u{1F1ED}\u{1F1F9}", englishName: "Haitian Creole", available: true, quality: "stable" },
  // Portuguese removed — Smallest has no native Portuguese voices in v2 or
  // v3.1 and no other provider is wired for PT. The `pt` code stays in the
  // Language union so legacy saved projects still typecheck on load. Hidden
  // from the picker via `available: false`.
  { id: "pt", label: "Português", flag: "\u{1F1F5}\u{1F1F9}", englishName: "Portuguese", available: false, quality: "beta" },
  { id: "nl", label: "Nederlands", flag: "\u{1F1F3}\u{1F1F1}", englishName: "Dutch", available: true, quality: "stable" },
  // C-3-6: DE / IT were retired from Smallest v2 and now route through
  // Gemini Flash. They work but aren't part of the original native-voice
  // roster, so we tag them 'beta' and surface a quality chip.
  { id: "de", label: "Deutsch", flag: "\u{1F1E9}\u{1F1EA}", englishName: "German", available: true, quality: "beta" },
  { id: "it", label: "Italiano", flag: "\u{1F1EE}\u{1F1F9}", englishName: "Italian", available: true, quality: "beta" },
  // C-3-6: RU / ZH / JA / KO previously fell through the SpeakerSelector
  // switch default (English voices) — fixed in Wave 5 to use Gemini
  // multilingual. Tag 'beta' until we collect real-user prosody feedback.
  { id: "ru", label: "Русский", flag: "\u{1F1F7}\u{1F1FA}", englishName: "Russian", available: true, quality: "beta" },
  { id: "zh", label: "中文", flag: "\u{1F1E8}\u{1F1F3}", englishName: "Chinese", available: true, quality: "beta" },
  { id: "ja", label: "日本語", flag: "\u{1F1EF}\u{1F1F5}", englishName: "Japanese", available: true, quality: "beta" },
  { id: "ko", label: "한국어", flag: "\u{1F1F0}\u{1F1F7}", englishName: "Korean", available: true, quality: "beta" },
];

// C-3-6: belt-and-braces filter — even when a locale is marked
// `available: true` in the table above, we still verify at runtime that
// SpeakerSelector returns at least one voice for that language. If a
// future SpeakerSelector refactor accidentally drops a locale's voice
// list, the picker hides the locale instead of letting the user pick
// it and immediately hit a no-voice error during the audio job.
function isLocaleWired(id: Language): boolean {
  try {
    const voices = getSpeakersForLanguage(id);
    return Array.isArray(voices) && voices.length > 0;
  } catch {
    return false;
  }
}

const visibleLanguages = languages.filter((l) => l.available && isLocaleWired(l.id));

export function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  // C-3-6: If the user lands on a locale that's been hidden (legacy
  // saved project pointing at `pt`, or a locale that gets retired in a
  // future sweep), still resolve a label for the trigger so the
  // dropdown doesn't render blank — but only OFFER `visibleLanguages`
  // for the user to switch to.
  const selected =
    visibleLanguages.find((l) => l.id === value) ||
    languages.find((l) => l.id === value) ||
    visibleLanguages[0];

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
              aria-label={`${selected.label} (${selected.englishName})${selected.quality === "beta" ? " — Beta" : ""}`}
            >
              <span aria-hidden="true">{selected.flag}</span>
              <span>{selected.label}</span>
              {selected.quality === "beta" && (
                <span
                  className="ml-1 px-1.5 py-px rounded font-mono text-[9px] tracking-wider uppercase border border-[#E4C875]/40 text-[#E4C875] bg-[#E4C875]/10"
                  aria-hidden="true"
                  title="Beta — voice quality may vary"
                >
                  Beta
                </span>
              )}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {visibleLanguages.map((lang) => (
            // Radix forwards arbitrary props to the underlying option DOM
            // node, so `lang` lands on the focusable list-item. Combined
            // with the per-row `aria-label`, screen readers either switch
            // voice synthesizer to the native-script tongue OR announce
            // the English equivalent — user-mode-dependent, both correct.
            <SelectItem
              key={lang.id}
              value={lang.id}
              lang={lang.id}
              aria-label={`${lang.label} (${lang.englishName})${lang.quality === "beta" ? " — Beta, voice quality may vary" : ""}`}
            >
              <span className="flex items-center gap-2 w-full">
                <span aria-hidden="true">{lang.flag}</span>
                <span>{lang.label}</span>
                {lang.quality === "beta" && (
                  <span
                    className="ml-auto px-1.5 py-px rounded font-mono text-[9px] tracking-wider uppercase border border-[#E4C875]/40 text-[#E4C875] bg-[#E4C875]/10"
                    aria-hidden="true"
                  >
                    Beta
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected.quality === "beta" && (
        <p className="text-[11px] text-[#8A9198] leading-relaxed">
          Beta — voice quality may vary while we tune {selected.englishName} prosody.
        </p>
      )}
    </div>
  );
}
