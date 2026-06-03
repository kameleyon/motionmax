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
  // Smallest removed — legacy sm:*/sm2:* ids now remap to Gemini in
  // the worker, but the Voice Lab UI still groups them under "gemini"
  // so the avatar tint reflects where the audio actually comes from.
  if (id.startsWith("sm:") || id.startsWith("sm2:")) return "gemini";
  // Adam = LemonFox (English Male only). All other legacy named
  // speakers (River, Pierre, Marie, Jacques, Camille, Carlos, Isabella)
  // are remapped to Gemini in the worker — surface them as "gemini"
  // here too so the Voice Lab UI doesn't claim Fish/ElevenLabs paths
  // that no longer run.
  if (id === "Adam") return "lemonfox";
  // Named built-in Fish s2-pro voices (see NAMED_FISH_VOICES in
  // worker/src/services/audioRouter.ts — keep in sync).
  if (id === "Zuri" || id === "Morpheus" || id === "Jacynthe" || id === "Phoebe" || id === "Eddy" || id === "Mario" || id === "Misko" || id === "Robert" || id === "Miriam" || id === "Roselie" || id === "Emily" || id === "Melanie" || id === "Tatiana" || id === "Micha" || id === "Ludovic" || id === "Richard" || id === "William" || id === "Claudel" || id === "Mikhal" || id === "Derrick" || id === "Eloise" || id === "Gabby" || id === "Sankofa") return "fish";
  return "gemini";
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

/** Avatar background gradient per accent.
 *
 *  Flag chip gradients use brand aqua/gold variants only; visual
 *  differentiation is by tonal shift, not by national flag colour, to
 *  avoid the WCAG/brand violation noted in Canon Critical-1 + Tongue 08.
 *  Brand rule: only aqua (#14C8CC) and gold (#E4C875) may appear in
 *  product UI — language identity is carried by the language name and
 *  the flag glyph emoji rendered alongside, not by the chip colour. */
export function avatarBackground(accent: string): string {
  switch (accent) {
    /* Aqua family — anchor on primary aqua, differentiate by depth. */
    case "US":    return "linear-gradient(135deg, #14C8CC, #0D99A8)"; // primary → deep aqua
    case "UK":    return "linear-gradient(135deg, #3DD4E0, #14C8CC)"; // light aqua → primary
    case "AU":    return "linear-gradient(135deg, #0FA6AE, #0D99A8)"; // mid-deep aqua
    case "IT":    return "linear-gradient(135deg, #7ad6e6, #0FA6AE)"; // pale → mid aqua
    case "Multi": return "linear-gradient(135deg, #14C8CC, #E4C875)"; // brand split
    /* Aqua → gold transitions for European / global accents. */
    case "FR":    return "linear-gradient(135deg, #14C8CC, #C9A75A)";
    case "DE":    return "linear-gradient(135deg, #0D99A8, #5A6268)"; // deep aqua → neutral ink-dim
    case "EU":    return "linear-gradient(135deg, #0FA6AE, #E4C875)";
    case "NL":    return "linear-gradient(135deg, #3DD4E0, #C9A75A)";
    /* Gold family — anchor on brand gold, differentiate by depth. */
    case "ES":    return "linear-gradient(135deg, #E4C875, #C9A75A)";
    case "LATAM": return "linear-gradient(135deg, #E4C875, #B4934A)"; // gold → deeper gold
    case "RU":    return "linear-gradient(135deg, #C9A75A, #5A6268)";
    case "CN":    return "linear-gradient(135deg, #E4C875, #14C8CC)"; // gold → aqua
    case "JP":    return "linear-gradient(135deg, #E4C875, #7ad6e6)"; // gold → pale aqua
    case "KR":    return "linear-gradient(135deg, #C9A75A, #0D99A8)";
    case "HT":    return "linear-gradient(135deg, #14C8CC, #C9A75A)";
    default:      return "linear-gradient(135deg, #14C8CC, #0FA6AE)";
  }
}
