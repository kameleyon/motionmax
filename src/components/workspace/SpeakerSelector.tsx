import { createScopedLogger } from "@/lib/logger";
import { useState, useRef, useCallback } from "react";
import { Mic, Play, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type SpeakerVoice =
  // Haitian Creole (Gemini TTS)
  | "Pierre" | "Marie"
  // French (Fish Audio)
  | "Jacques" | "Camille"
  // Spanish (Fish Audio)
  | "Carlos" | "Isabella"
  // English (LemonFox / Fish Audio)
  | "Adam" | "River"
  // Legacy Qwen3 types kept in the union so previously-saved projects that
  // reference them still typecheck when loaded. The worker routes them
  // through the standard audio chain (see handleCinematicAudio.ts).
  | "Nova" | "Atlas" | "Kai" | "Marcus" | "Luna"
  | "Leo" | "Maya" | "Sage" | "Aria"
  // Smallest.ai Lightning v3.1 — `sm:*` prefix routes to the v3.1 endpoint.
  // English (US, American accent only) — all 29 voices tagged
  // language:english + accent:american in the live API catalog.
  | "sm:avery"     | "sm:mia"        | "sm:quinn"     | "sm:sophia"
  | "sm:robert"    | "sm:sandra"     | "sm:daniel"    | "sm:lucas"
  | "sm:vanessa"   | "sm:brooke"     | "sm:dina"      | "sm:kevin"
  | "sm:rachel"    | "sm:nicole"     | "sm:ethan"     | "sm:hannah"
  | "sm:lauren"    | "sm:olivia"     | "sm:magnus"    | "sm:brian"
  | "sm:ella"      | "sm:alex"       | "sm:johnny"    | "sm:jessica"
  | "sm:jordan"    | "sm:divyanshu"  | "sm:elizabeth" | "sm:harper"
  | "sm:kyle"
  // Spanish (mexican/latin accent) — all 11 voices from v3.1.
  | "sm:daniella"  | "sm:carlos"     | "sm:jose"      | "sm:luis"
  | "sm:mariana"   | "sm:miguel"     | "sm:lucia"     | "sm:javier"
  | "sm:camilla"   | "sm:diego"      | "sm:gabriela"
  // Smallest.ai Lightning v2 — removed from the dropdown (poor quality).
  // IDs kept in the union so legacy saved projects still typecheck on
  // load. Worker refuses them at runtime if re-selected.
  | "sm2:claire"   | "sm2:emmanuel"     // French (retired)
  | "sm2:adele"    | "sm2:leon"         // German (retired)
  | "sm2:maria"    | "sm2:enzo"         // Italian (retired)
  | "sm2:adriana"  | "sm2:lukas"        // Dutch (retired)
  | "sm2:gerard"   | "sm2:isabel"       // Spanish v2 (retired)
  // Gemini 3.1 Flash TTS — `gm:*` prefix, multilingual voices. Used for
  // French / Spanish / Italian / German / Dutch. Each voice works across
  // all Gemini-supported languages; the model picks the accent from the
  // input text. Tone descriptors from Google's official Gemini TTS docs.
  | "gm:Leda"         | "gm:Aoede"        | "gm:Callirrhoe"
  | "gm:Kore"         | "gm:Vindemiatrix" | "gm:Achernar"
  | "gm:Sulafat"      | "gm:Laomedeia"
  | "gm:Erinome"      | "gm:Zephyr"
  | "gm:Charon"       | "gm:Orus"         | "gm:Iapetus"
  | "gm:Fenrir"       | "gm:Algenib"      | "gm:Rasalgethi"
  | "gm:Puck"         | "gm:Schedar"      | "gm:Umbriel"
  | "gm:Enceladus"    | "gm:Algieba"      | "gm:Zubenelgenubi";

const log = createScopedLogger("SpeakerSelector");

interface SpeakerSelectorProps {
  value: SpeakerVoice;
  onChange: (value: SpeakerVoice) => void;
  language?: string;
}

export interface SpeakerOption { id: SpeakerVoice; label: string; description: string }

// Qwen3 (Replicate) is disabled — only Fish Audio / LemonFox / Gemini speakers
// are offered in the UI. Re-introduce the qwenSpeakers list when Qwen3 is
// re-enabled in the worker.

// Smallest.ai voices (additive — legacy Fish Audio / LemonFox / Gemini
// speakers are untouched). Where a name collides with a legacy speaker
// (e.g. "Carlos"), we suffix " 2" on the Smallest label so the dropdown
// stays unambiguous without touching the legacy label. Voice ids are
// namespaced with `sm:` (v3.1) or `sm2:` (v2) so they never collide.

// English (US) — ALL 29 American-accent voices from the Smallest v3.1
// live catalog. Alphabetized by label within each gender group. Voice
// data (gender, accent) pulled from GET /waves/v1/lightning-v3.1/get_voices.
const englishSmallestSpeakers: SpeakerOption[] = [
  // Female (American accent)
  { id: "sm:avery",     label: "Avery",     description: "Female · Energetic, upbeat · social-media" },
  { id: "sm:brooke",    label: "Brooke",    description: "Female · Warm, conversational · explainers" },
  { id: "sm:dina",      label: "Dina",      description: "Female · Mature, authoritative · documentary" },
  { id: "sm:elizabeth", label: "Elizabeth", description: "Female · Calm, sophisticated · luxury/brand" },
  { id: "sm:ella",      label: "Ella",      description: "Female · Youthful, bright · lifestyle/wellness" },
  { id: "sm:hannah",    label: "Hannah",    description: "Female · Friendly, approachable · tutorials" },
  { id: "sm:harper",    label: "Harper",    description: "Female · Bright, expressive · storytelling" },
  { id: "sm:jessica",   label: "Jessica",   description: "Female · Smooth, professional · corporate" },
  { id: "sm:kevin",     label: "Kevin",     description: "Female · Soft, intimate · meditation/ASMR" }, // API tags Kevin as female
  { id: "sm:lauren",    label: "Lauren",    description: "Female · Clear, articulate · e-learning" },
  { id: "sm:mia",       label: "Mia",       description: "Female · Young, playful · kids/animated" },
  { id: "sm:nicole",    label: "Nicole",    description: "Female · Confident, business · sales/marketing" },
  { id: "sm:olivia",    label: "Olivia",    description: "Female · Warm, welcoming · hospitality" },
  { id: "sm:quinn",     label: "Quinn",     description: "Female · Modern, youthful · social-media" },
  { id: "sm:rachel",    label: "Rachel",    description: "Female · Classic, neutral · versatile narration" },
  { id: "sm:sandra",    label: "Sandra",    description: "Female · Mature, storytelling · documentary" },
  { id: "sm:sophia",    label: "Sophia",    description: "Female · Elegant, refined · premium brand" },
  { id: "sm:vanessa",   label: "Vanessa",   description: "Female · Bold, expressive · advertising" },
  // Male (American accent)
  { id: "sm:alex",      label: "Alex",      description: "Male · Casual, everyday · vlogs/talking-head" },
  { id: "sm:brian",     label: "Brian",     description: "Male · Deep, authoritative · trailers/corporate" },
  { id: "sm:daniel",    label: "Daniel",    description: "Male · Warm, measured · documentary" },
  { id: "sm:divyanshu", label: "Divyanshu", description: "Male · Conversational · Indian-American accent" },
  { id: "sm:ethan",     label: "Ethan",     description: "Male · Young, energetic · social-media/ads" },
  { id: "sm:johnny",    label: "Johnny",    description: "Male · Gravelly, mature · storytelling" },
  { id: "sm:jordan",    label: "Jordan",    description: "Male · Neutral, flexible · versatile narration" },
  { id: "sm:kyle",      label: "Kyle",      description: "Male · Bright, youthful · product demos" },
  { id: "sm:lucas",     label: "Lucas",     description: "Male · Smooth, cinematic · voiceover" },
  { id: "sm:magnus",    label: "Magnus",    description: "Male · Deep, commanding · trailers/epic" },
  { id: "sm:robert",    label: "Robert",    description: "Male · Classic, professional · corporate/news" },
];

// Spanish — all 11 voices from Smallest v3.1 (mexican/latin accent).
// v2 extras removed (Gerard/Isabel) — v2 voices were replaced by Gemini
// Flash below for the European-language lineup.
const spanishSmallestSpeakers: SpeakerOption[] = [
  // Female (v3.1)
  { id: "sm:camilla",  label: "Camilla",   description: "Female · Warm, conversational · Latin accent" },
  { id: "sm:daniella", label: "Daniella",  description: "Female · Bright, youthful · social-media" },
  { id: "sm:gabriela", label: "Gabriela",  description: "Female · Clear, conversational · tutorials" },
  { id: "sm:lucia",    label: "Lucia",     description: "Female · Elegant, refined · premium brand" },
  { id: "sm:mariana",  label: "Mariana",   description: "Female · Expressive, storytelling · narrative" },
  // Male (v3.1)
  { id: "sm:carlos",   label: "Carlos 2",  description: "Male · Smooth, neutral · Latin accent" },
  { id: "sm:diego",    label: "Diego",     description: "Male · Bold, confident · advertising" },
  { id: "sm:javier",   label: "Javier",    description: "Male · Measured, documentary · narration" },
  { id: "sm:jose",     label: "Jose",      description: "Male · Casual, friendly · vlogs/talking-head" },
  { id: "sm:luis",     label: "Luis",      description: "Male · Deep, authoritative · trailers/corporate" },
  { id: "sm:miguel",   label: "Miguel",    description: "Male · Warm, approachable · explainers" },
];

// Gemini 3.1 Flash TTS — 15 voices that work across FR/ES/IT/DE/NL (model
// picks the accent from the narration text). Descriptions are the tone
// descriptors from Google's official docs, not gender labels, because
// Gemini voices are intentionally non-gendered — listeners perceive gender
// differently per voice+language combo.
//
// Selection rationale: balanced spread of tones for a 15-slot lineup.
// 8 lighter/softer voices + 7 deeper/firmer voices, covering
// documentary, conversational, energetic, and gentle use cases.
const geminiFlashSpeakers: SpeakerOption[] = [
  // Female-leaning voices (Google's internal gender bias per their
  // docs). Description = perceived gender + tone so users picking a
  // "social media influencer" voice can actually tell what they're
  // choosing instead of guessing from abstract tone descriptors.
  { id: "gm:Leda",          label: "Leda",          description: "Female · Youthful, playful" },
  { id: "gm:Aoede",         label: "Aoede",         description: "Female · Breezy, light" },
  { id: "gm:Callirrhoe",    label: "Callirrhoe",    description: "Female · Easy-going" },
  { id: "gm:Sulafat",       label: "Sulafat",       description: "Female · Warm, conversational" },
  { id: "gm:Vindemiatrix",  label: "Vindemiatrix",  description: "Female · Gentle" },
  { id: "gm:Achernar",      label: "Achernar",      description: "Female · Soft" },
  { id: "gm:Laomedeia",     label: "Laomedeia",     description: "Female · Upbeat, social-media style" },
  { id: "gm:Kore",          label: "Kore",          description: "Female · Firm, authoritative" },
  { id: "gm:Erinome",       label: "Erinome",       description: "Female · Clear, articulate" },
  { id: "gm:Zephyr",        label: "Zephyr",        description: "Female · Bright, higher pitch" },
  // Male-leaning voices.
  { id: "gm:Charon",        label: "Charon",        description: "Male · Informative, documentary" },
  { id: "gm:Orus",          label: "Orus",          description: "Male · Firm, serious (dramatic)" },
  { id: "gm:Iapetus",       label: "Iapetus",       description: "Male · Clear, neutral" },
  { id: "gm:Rasalgethi",    label: "Rasalgethi",    description: "Male · Informative, explanatory" },
  { id: "gm:Algenib",       label: "Algenib",       description: "Male · Gravelly, deep" },
  { id: "gm:Fenrir",        label: "Fenrir",        description: "Male · Excitable, energetic" },
  { id: "gm:Puck",          label: "Puck",          description: "Male · Upbeat, social-media style" },
  { id: "gm:Schedar",       label: "Schedar",       description: "Male · Even, measured" },
  { id: "gm:Umbriel",       label: "Umbriel",       description: "Male · Easy-going" },
  { id: "gm:Enceladus",     label: "Enceladus",     description: "Male · Breathy, intimate" },
  { id: "gm:Algieba",       label: "Algieba",       description: "Male · Smooth, lower pitch" },
  { id: "gm:Zubenelgenubi", label: "Zubenelgenubi", description: "Male · Casual, conversational" },
];

const creoleSpeakers: SpeakerOption[] = [
  { id: "Pierre", label: "Pierre", description: "Male · Warm, measured · Haitian Creole narration" },
  { id: "Marie",  label: "Marie",  description: "Female · Clear, friendly · Haitian Creole narration" },
];

const frenchSpeakers: SpeakerOption[] = [
  // Legacy Fish Audio voices — untouched.
  { id: "Jacques", label: "Jacques", description: "Male · Neutral, professional · French narration/corporate" },
  { id: "Camille", label: "Camille", description: "Female · Warm, conversational · French explainers/lifestyle" },
  // Gemini 3.1 Flash (multilingual) — 15 voices.
  ...geminiFlashSpeakers,
];

const spanishSpeakers: SpeakerOption[] = [
  // Legacy Fish Audio voices — untouched.
  { id: "Carlos",   label: "Carlos",   description: "Male · Authoritative, mature · Spanish corporate/news" },
  { id: "Isabella", label: "Isabella", description: "Female · Warm, expressive · Spanish storytelling" },
  // Smallest v3.1 Spanish voices — retained (quality is fine here).
  ...spanishSmallestSpeakers,
  // Gemini 3.1 Flash (multilingual) — 15 voices.
  ...geminiFlashSpeakers,
];

const englishSpeakers: SpeakerOption[] = [
  // Gemini 3.1 Flash voices FIRST — testing whether the Google API
  // can keep up for 28-scene English projects. If it holds, this is
  // the new default ordering; if it doesn't, users can still pick
  // Adam / River / Smallest voices lower down.
  ...geminiFlashSpeakers,
  // Legacy Adam/River — kept for continuity, pushed below Gemini.
  { id: "Adam",  label: "Adam",  description: "Male · Versatile, confident · general-purpose narration" },
  { id: "River", label: "River", description: "Female · Professional, clear · corporate/explainers" },
  // Smallest v3.1 29-voice American-English catalog — pushed to the
  // bottom but still fully available.
  ...englishSmallestSpeakers,
];

// Languages where Gemini Flash is the SOLE non-HC provider. Gemini
// voices auto-adapt the accent to the language — the model reads the
// accent from the input text, so the exact same 15-voice roster
// serves every one of these. Russian / Chinese / Japanese / Korean
// previously fell through the switch default (English voices) —
// now they get proper native-speaking Gemini voices.
const germanSpeakers: SpeakerOption[]   = geminiFlashSpeakers;
const italianSpeakers: SpeakerOption[]  = geminiFlashSpeakers;
const dutchSpeakers: SpeakerOption[]    = geminiFlashSpeakers;
const russianSpeakers: SpeakerOption[]  = geminiFlashSpeakers;
const chineseSpeakers: SpeakerOption[]  = geminiFlashSpeakers;
const japaneseSpeakers: SpeakerOption[] = geminiFlashSpeakers;
const koreanSpeakers: SpeakerOption[]   = geminiFlashSpeakers;

export function getSpeakersForLanguage(language?: string): SpeakerOption[] {
  switch (language) {
    case "ht": return creoleSpeakers;
    case "fr": return frenchSpeakers;
    case "es": return spanishSpeakers;
    case "en": return englishSpeakers;
    case "de": return germanSpeakers;
    case "it": return italianSpeakers;
    case "nl": return dutchSpeakers;
    case "ru": return russianSpeakers;
    case "zh": return chineseSpeakers;
    case "ja": return japaneseSpeakers;
    case "ko": return koreanSpeakers;
    default: return englishSpeakers;
  }
}

export function getDefaultSpeaker(language: string): SpeakerVoice {
  switch (language) {
    case "ht": return "Pierre";
    case "fr": return "Camille";
    case "es": return "Isabella";
    // English default stays "Adam" (legacy Fish Audio) so existing
    // users don't get a surprise voice swap on their next project.
    // The Gemini voices sit above Adam in the list for easy testing.
    case "en": return "Adam";
    // Gemini-only languages default to a warm, conversational voice
    // that reads well across most content.
    case "de": return "gm:Sulafat";
    case "it": return "gm:Sulafat";
    case "nl": return "gm:Sulafat";
    case "ru": return "gm:Sulafat";
    case "zh": return "gm:Sulafat";
    case "ja": return "gm:Sulafat";
    case "ko": return "gm:Sulafat";
    default: return "Adam";
  }
}

/** Sample text in each language for voice preview.
 *  Unified script: greeting + creative invitation, so every voice says the
 *  same thing and can be compared apples-to-apples. */
export function getSampleText(speakerName: string, language: string): string {
  switch (language) {
    case "ht": return `Bonjou, mwen se ${speakerName}. Mèsi paske w chwazi vwa m jodi a. Kisa n ap kreye?`;
    case "fr": return `Bonjour, je suis ${speakerName}. Merci d'avoir choisi ma voix aujourd'hui. Qu'allons-nous cr\u00e9er ?`;
    case "es": return `Hola, soy ${speakerName}. Gracias por elegir mi voz hoy. \u00bfQu\u00e9 vamos a crear?`;
    case "pt": return `Ol\u00e1, sou ${speakerName}. Obrigado por escolher minha voz hoje. O que vamos criar?`;
    case "de": return `Hallo, ich bin ${speakerName}. Danke, dass Sie heute meine Stimme gew\u00e4hlt haben. Was erschaffen wir?`;
    case "it": return `Ciao, sono ${speakerName}. Grazie per aver scelto la mia voce oggi. Cosa creeremo?`;
    case "ru": return `\u041f\u0440\u0438\u0432\u0435\u0442, \u044f ${speakerName}. \u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0447\u0442\u043e \u0432\u044b\u0431\u0440\u0430\u043b\u0438 \u043c\u043e\u0439 \u0433\u043e\u043b\u043e\u0441. \u0427\u0442\u043e \u043c\u044b \u0431\u0443\u0434\u0435\u043c \u0441\u043e\u0437\u0434\u0430\u0432\u0430\u0442\u044c?`;
    case "zh": return `\u4f60\u597d\uff0c\u6211\u662f${speakerName}\u3002\u8c22\u8c22\u4f60\u4eca\u5929\u9009\u62e9\u4e86\u6211\u7684\u58f0\u97f3\u3002\u6211\u4eec\u8981\u521b\u4f5c\u4ec0\u4e48\uff1f`;
    case "ja": return `\u3053\u3093\u306b\u3061\u306f\u3001${speakerName}\u3067\u3059\u3002\u4eca\u65e5\u306f\u79c1\u306e\u58f0\u3092\u9078\u3093\u3067\u3044\u305f\u3060\u304d\u3042\u308a\u304c\u3068\u3046\u3054\u3056\u3044\u307e\u3059\u3002\u4f55\u3092\u4f5c\u308a\u307e\u3057\u3087\u3046\u304b\uff1f`;
    case "ko": return `\uc548\ub155\ud558\uc138\uc694, ${speakerName}\uc785\ub2c8\ub2e4. \uc624\ub298 \uc81c \ubaa9\uc18c\ub9ac\ub97c \uc120\ud0dd\ud574 \uc8fc\uc154\uc11c \uac10\uc0ac\ud569\ub2c8\ub2e4. \ubb34\uc5c7\uc744 \ub9cc\ub4e4\uc5b4 \ubcfc\uae4c\uc694?`;
    default: return `Hello, I'm ${speakerName}. Thanks for choosing my voice today. What are we creating?`;
  }
}

const CACHE_KEY = "motionmax_voice_previews";

function getCachedPreview(speakerId: string, language: string): string | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return cache[`${speakerId}_${language}`] || null;
  } catch { return null; }
}

function setCachedPreview(speakerId: string, language: string, url: string) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache[`${speakerId}_${language}`] = url;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

export function SpeakerSelector({ value, onChange, language }: SpeakerSelectorProps) {
  const speakers = getSpeakersForLanguage(language);
  const selected = speakers.find((s) => s.id === value) || speakers[0];
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setPreviewPlaying(null);
  }, []);

  const playPreview = useCallback(async (speaker: SpeakerOption, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    // If already playing this voice, stop it
    if (previewPlaying === speaker.id) {
      stopPlayback();
      return;
    }

    stopPlayback();

    // Check cache first (keyed by speaker + language)
    const lang = language || "en";
    const cached = getCachedPreview(speaker.id, lang);
    if (cached) {
      const audio = new Audio(cached);
      audioRef.current = audio;
      setPreviewPlaying(speaker.id);
      audio.onended = () => setPreviewPlaying(null);
      audio.onerror = () => setPreviewPlaying(null);
      audio.play().catch(() => setPreviewPlaying(null));
      return;
    }

    // Generate preview via worker
    setPreviewLoading(speaker.id);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const sampleText = getSampleText(speaker.label, language || "en");

      const { data: job, error } = await supabase
        .from("video_generation_jobs")
        .insert({
          user_id: user.id,
          task_type: "voice_preview",
          payload: {
            speaker: speaker.id,
            language: language || "en",
            text: sampleText,
          },
          status: "pending",
        })
        .select("id")
        .single();

      if (error || !job) throw new Error("Failed to queue preview");

      // Poll for result
      const MAX_WAIT = 30000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT) {
        await new Promise(r => setTimeout(r, 2000));
        const { data: row } = await (supabase
          .from("video_generation_jobs") as unknown as ReturnType<typeof supabase.from>)
          .select("status, result")
          .eq("id", job.id)
          .single();

        if (row?.status === "completed" && row?.result?.audioUrl) {
          const url = row.result.audioUrl;
          setCachedPreview(speaker.id, lang, url);
          const audio = new Audio(url);
          audioRef.current = audio;
          setPreviewPlaying(speaker.id);
          audio.onended = () => setPreviewPlaying(null);
          audio.onerror = () => setPreviewPlaying(null);
          audio.play().catch(() => setPreviewPlaying(null));
          break;
        }
        if (row?.status === "failed") break;
      }
    } catch (err) {
      log.warn("Voice preview failed:", err);
      toast.error("Voice preview unavailable. Please try again.");
    } finally {
      setPreviewLoading(null);
    }
  }, [language, previewPlaying, stopPlayback]);

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
        <Mic className="h-3.5 w-3.5" />
        Voice
      </h3>
      <div className="flex items-center gap-2">
        <Select value={value} onValueChange={(v) => { stopPlayback(); onChange(v as SpeakerVoice); }}>
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
                <span className="flex items-center gap-2 w-full">
                  <span className="font-medium">{s.label}</span>
                  <span className="text-muted-foreground text-xs flex-1">{s.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Preview play button for currently selected voice */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full border border-primary/30 hover:bg-primary/10"
          disabled={previewLoading !== null}
          onClick={(e) => playPreview(selected, e)}
          title={previewPlaying === selected.id ? "Stop preview" : "Preview voice"}
        >
          {previewLoading === selected.id ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : previewPlaying === selected.id ? (
            <Square className="h-3 w-3 text-primary fill-primary" />
          ) : (
            <Play className="h-3.5 w-3.5 text-primary fill-primary" />
          )}
        </Button>
      </div>
    </div>
  );
}
