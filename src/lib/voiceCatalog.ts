/** Voice Lab Discovery catalog — derives structured metadata from the
 *  loose `description` strings in SpeakerSelector. The selector stores
 *  things like `"Female · Energetic, upbeat · social-media"` so the
 *  intake dropdown can display a short blurb; Voice Lab needs the same
 *  data factored apart (gender / age / accent / tags) so it can power
 *  filter chips, gender icons, accent flags, and search.
 *
 *  We intentionally derive at the call site instead of editing every
 *  description string in SpeakerSelector — the selector already ships
 *  in production and changing those strings would break the dropdown
 *  copy. A small parser keeps the two representations in sync without
 *  touching the source of truth. */

import { getSpeakersForLanguage, type SpeakerOption, type SpeakerVoice } from "@/components/workspace/SpeakerSelector";

export type Gender = "Male" | "Female" | "Neutral";
export type Age = "Young" | "Middle Aged" | "Old" | "Any";

export interface CatalogVoice {
  /** Stable id from SpeakerSelector — what the worker accepts. */
  id: SpeakerVoice;
  /** Display name — uses `label` from the dropdown (already pretty). */
  name: string;
  /** Initial used inside the avatar circle. */
  initial: string;
  /** Two-letter accent code we display + map to a flag. */
  accent: string;
  /** Flag emoji corresponding to `accent`. */
  flag: string;
  gender: Gender;
  age: Age;
  /** Free-form tags drawn from the description's third segment, plus
   *  inferred ones from common keywords ("conversational", "deep",
   *  etc). Used for the chip-row filter + on the card. */
  tags: string[];
  /** Source provider — we colour the avatar slightly differently per
   *  provider so users can tell at-a-glance whether a voice runs
   *  through Gemini, Smallest, Fish Audio, or LemonFox. */
  provider: "gemini" | "smallest" | "fish" | "lemonfox" | "qwen";
  /** Original description from SpeakerSelector — preserved verbatim
   *  so the playground can show the same blurb the intake dropdown
   *  shows when this voice is selected. */
  description: string;
}

const FLAG_BY_ACCENT: Record<string, string> = {
  US: "🇺🇸", UK: "🇬🇧", AU: "🇦🇺", IN: "🇮🇳", FR: "🇫🇷",
  DE: "🇩🇪", ES: "🇪🇸", JP: "🇯🇵", IT: "🇮🇹", NL: "🇳🇱",
  RU: "🇷🇺", CN: "🇨🇳", KR: "🇰🇷", HT: "🇭🇹", LATAM: "🌎",
  EU: "🇪🇺", "Multi": "🌐",
};

/** Default accent inferred from a voice id prefix or language slot.
 *  Most Gemini voices are multilingual so we mark them as Multi; the
 *  Smallest English roster is American; Smallest Spanish is LATAM;
 *  legacy Fish/LemonFox names are mapped from their language column. */
function accentForId(id: string, languageCode: string): string {
  if (id.startsWith("gm:")) return "Multi";
  if (id.startsWith("sm:") && languageCode === "es") return "LATAM";
  if (id.startsWith("sm:") && languageCode === "en") return "US";
  if (id.startsWith("sm2:")) return "EU";
  switch (languageCode) {
    case "en": return "US";
    case "ht": return "HT";
    case "fr": return "FR";
    case "es": return "ES";
    case "de": return "DE";
    case "it": return "IT";
    case "nl": return "NL";
    case "ru": return "RU";
    case "zh": return "CN";
    case "ja": return "JP";
    case "ko": return "KR";
    default:   return "US";
  }
}

function providerForId(id: string): CatalogVoice["provider"] {
  if (id.startsWith("gm:")) return "gemini";
  if (id.startsWith("sm:") || id.startsWith("sm2:")) return "smallest";
  // Adam / River = LemonFox; the Pierre/Marie/Jacques/Camille/Carlos/
  // Isabella legacy voices route through Fish Audio.
  if (id === "Adam" || id === "River") return "lemonfox";
  return "fish";
}

/** Pull "Male" / "Female" from the description. The selector strings
 *  are remarkably consistent — the first segment before the first ` · `
 *  is always the gender label. Fallback to "Neutral" so a future
 *  description that omits the prefix doesn't crash the filter. */
function parseGender(description: string): Gender {
  const head = description.split("·")[0]?.trim().toLowerCase() ?? "";
  if (head.startsWith("female")) return "Female";
  if (head.startsWith("male")) return "Male";
  return "Neutral";
}

/** Infer an age bucket from tone keywords. The selector descriptions
 *  don't carry an explicit age so we map common adjectives:
 *  young/youthful → Young, mature/old/deep → Old, everything else →
 *  Middle Aged. Same scheme the HTML template demoed for fake voices. */
function parseAge(description: string): Age {
  const d = description.toLowerCase();
  if (/\byoung|youthful|playful|kid|child|bright\b/.test(d)) return "Young";
  if (/\bmature|old|deep|gravelly|elder|aged|grand\b/.test(d)) return "Old";
  return "Middle Aged";
}

/** Tags = the keywords after the gender prefix, plus the use-case
 *  segment after the second `·`. We split on commas + spaces, drop
 *  short connector words, and dedupe. Keeps the chip rail compact. */
function parseTags(description: string): string[] {
  const segments = description.split("·").slice(1).map((s) => s.trim());
  const raw = segments.flatMap((s) => s.split(/[,/]/));
  const cleaned = raw
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^[a-z]+\s*$/i.test(t.split(" ")[0]) || t.length >= 4);
  return Array.from(new Set(cleaned)).slice(0, 6);
}

/** Build a deterministic 32-bar waveform per voice id so the same
 *  voice always renders the same waveform shape across re-renders.
 *  Heights in 30..90 (%) — anything lower disappears under the row. */
export function waveformBars(id: string): number[] {
  const seed0 = id.charCodeAt(0) || 65;
  return Array.from({ length: 32 }, (_, i) => {
    const seed = (seed0 + i * 7) % 11;
    return 30 + ((seed * 7) % 60);
  });
}

export function flagFor(accent: string): string {
  return FLAG_BY_ACCENT[accent] ?? "🌐";
}

/** Promote a SpeakerOption + language hint into the structured shape
 *  the Voice Lab UI consumes. Pure — safe to call inside useMemo. */
function toCatalogVoice(opt: SpeakerOption, languageCode: string): CatalogVoice {
  const accent = accentForId(opt.id, languageCode);
  return {
    id: opt.id,
    name: opt.label,
    initial: (opt.label[0] || "?").toUpperCase(),
    accent,
    flag: flagFor(accent),
    gender: parseGender(opt.description),
    age: parseAge(opt.description),
    tags: parseTags(opt.description),
    provider: providerForId(opt.id),
    description: opt.description,
  };
}

/** Promote a user-cloned voice into the same catalog shape as built-in
 *  speakers so it can ride through the Voice Lab grid + TestPlayground
 *  without a separate code path. The id stays in `clone:<external_id>`
 *  form so the worker's voice_preview handler can route to the right
 *  provider; everything else is cosmetic. */
export function cloneToCatalogVoice(
  clone: { pickerId: string; externalId: string; name: string; provider: "fish" | "elevenlabs"; description?: string | null },
): CatalogVoice {
  const description = (clone as { description?: string | null }).description
    || `Your cloned voice · ${clone.provider === "fish" ? "Fish s2-pro" : "ElevenLabs"}`;
  return {
    id: clone.pickerId as SpeakerVoice, // "clone:<uuid>" — recognized by handleVoicePreview
    name: clone.name,
    initial: (clone.name[0] || "?").toUpperCase(),
    accent: "Multi", // clones speak any language via Fish s2-pro
    flag: FLAG_BY_ACCENT["Multi"],
    gender: "Neutral",
    age: "Any",
    tags: ["cloned voice", clone.provider === "fish" ? "fish" : "elevenlabs"],
    provider: clone.provider, // "fish" | "elevenlabs"
    description,
  };
}

/** Get the full catalog for the given language. De-duplicates by id
 *  because some Gemini voices are spread across multiple language
 *  buckets in SpeakerSelector — we only want each voice once. */
export function getCatalog(languageCode: string): CatalogVoice[] {
  const opts = getSpeakersForLanguage(languageCode);
  const seen = new Set<string>();
  const out: CatalogVoice[] = [];
  for (const opt of opts) {
    if (seen.has(opt.id)) continue;
    seen.add(opt.id);
    out.push(toCatalogVoice(opt, languageCode));
  }
  return out;
}

/** Languages the Voice Lab dropdown offers. Mirrors the keys handled
 *  inside getSpeakersForLanguage's switch — keep them in sync if a
 *  new language slot is added there. */
export const LANGUAGES: Array<{ code: string; label: string; flag: string }> = [
  { code: "en", label: "English",         flag: "🇺🇸" },
  { code: "fr", label: "French",          flag: "🇫🇷" },
  { code: "es", label: "Spanish",         flag: "🇪🇸" },
  { code: "ht", label: "Haitian Creole",  flag: "🇭🇹" },
  { code: "de", label: "German",          flag: "🇩🇪" },
  { code: "it", label: "Italian",         flag: "🇮🇹" },
  { code: "nl", label: "Dutch",           flag: "🇳🇱" },
  { code: "ru", label: "Russian",         flag: "🇷🇺" },
  { code: "zh", label: "Chinese",         flag: "🇨🇳" },
  { code: "ja", label: "Japanese",        flag: "🇯🇵" },
  { code: "ko", label: "Korean",          flag: "🇰🇷" },
];

/** Avatar background colour per accent — same hue family as the
 *  accent flag to keep the card visually anchored. Tailwind-style
 *  arbitrary value strings so callers can pass them straight to
 *  inline `style={{ background }}`. */
export function avatarBackground(accent: string): string {
  switch (accent) {
    case "US":    return "linear-gradient(135deg, #3B82F6, #1E40AF)";
    case "UK":    return "linear-gradient(135deg, #EF4444, #991B1B)";
    case "AU":    return "linear-gradient(135deg, #10B981, #047857)";
    case "FR":    return "linear-gradient(135deg, #6366F1, #312E81)";
    case "ES":    return "linear-gradient(135deg, #F59E0B, #B45309)";
    case "LATAM": return "linear-gradient(135deg, #F97316, #C2410C)";
    case "DE":    return "linear-gradient(135deg, #525252, #171717)";
    case "IT":    return "linear-gradient(135deg, #14B8A6, #0F766E)";
    case "NL":    return "linear-gradient(135deg, #F97316, #1E3A8A)";
    case "RU":    return "linear-gradient(135deg, #DC2626, #7F1D1D)";
    case "CN":    return "linear-gradient(135deg, #DC2626, #FBBF24)";
    case "JP":    return "linear-gradient(135deg, #F472B6, #BE185D)";
    case "KR":    return "linear-gradient(135deg, #6366F1, #C026D3)";
    case "HT":    return "linear-gradient(135deg, #1D4ED8, #DC2626)";
    case "Multi": return "linear-gradient(135deg, #14C8CC, #6366F1)";
    case "EU":    return "linear-gradient(135deg, #1E40AF, #FBBF24)";
    default:      return "linear-gradient(135deg, #14C8CC, #0FA6AE)";
  }
}
