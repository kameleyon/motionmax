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
  // Smallest.ai Lightning v2 — `sm2:*` prefix routes to the v2 endpoint.
  // European voices that weren't ported to v3.1, plus 2 extra Spanish.
  | "sm2:claire"   | "sm2:emmanuel"     // French
  | "sm2:adele"    | "sm2:leon"         // German
  | "sm2:maria"    | "sm2:enzo"         // Italian
  | "sm2:adriana"  | "sm2:lukas"        // Dutch
  | "sm2:gerard"   | "sm2:isabel";      // Spanish (v2 extras)

const log = createScopedLogger("SpeakerSelector");

interface SpeakerSelectorProps {
  value: SpeakerVoice;
  onChange: (value: SpeakerVoice) => void;
  language?: string;
}

interface SpeakerOption { id: SpeakerVoice; label: string; description: string }

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
  { id: "sm:avery",     label: "Avery",     description: "Female" },
  { id: "sm:brooke",    label: "Brooke",    description: "Female" },
  { id: "sm:dina",      label: "Dina",      description: "Female" },
  { id: "sm:elizabeth", label: "Elizabeth", description: "Female" },
  { id: "sm:ella",      label: "Ella",      description: "Female" },
  { id: "sm:hannah",    label: "Hannah",    description: "Female" },
  { id: "sm:harper",    label: "Harper",    description: "Female" },
  { id: "sm:jessica",   label: "Jessica",   description: "Female" },
  { id: "sm:kevin",     label: "Kevin",     description: "Female" }, // API tags Kevin as female
  { id: "sm:lauren",    label: "Lauren",    description: "Female" },
  { id: "sm:mia",       label: "Mia",       description: "Female" },
  { id: "sm:nicole",    label: "Nicole",    description: "Female" },
  { id: "sm:olivia",    label: "Olivia",    description: "Female" },
  { id: "sm:quinn",     label: "Quinn",     description: "Female" },
  { id: "sm:rachel",    label: "Rachel",    description: "Female" },
  { id: "sm:sandra",    label: "Sandra",    description: "Female" },
  { id: "sm:sophia",    label: "Sophia",    description: "Female" },
  { id: "sm:vanessa",   label: "Vanessa",   description: "Female" },
  // Male (American accent)
  { id: "sm:alex",      label: "Alex",      description: "Male" },
  { id: "sm:brian",     label: "Brian",     description: "Male" },
  { id: "sm:daniel",    label: "Daniel",    description: "Male" },
  { id: "sm:divyanshu", label: "Divyanshu", description: "Male" },
  { id: "sm:ethan",     label: "Ethan",     description: "Male" },
  { id: "sm:johnny",    label: "Johnny",    description: "Male" },
  { id: "sm:jordan",    label: "Jordan",    description: "Male" },
  { id: "sm:kyle",      label: "Kyle",      description: "Male" },
  { id: "sm:lucas",     label: "Lucas",     description: "Male" },
  { id: "sm:magnus",    label: "Magnus",    description: "Male" },
  { id: "sm:robert",    label: "Robert",    description: "Male" },
];

// Spanish — all 11 voices from v3.1 (mexican/latin accent) + 2 extras
// from v2 so users can compare v3.1 vs v2 quality.
const spanishSmallestSpeakers: SpeakerOption[] = [
  // Female (v3.1)
  { id: "sm:camilla",  label: "Camilla",   description: "Female" },
  { id: "sm:daniella", label: "Daniella",  description: "Female" },
  { id: "sm:gabriela", label: "Gabriela",  description: "Female" },
  { id: "sm:lucia",    label: "Lucia",     description: "Female" },
  { id: "sm:mariana",  label: "Mariana",   description: "Female" },
  // Male (v3.1)
  { id: "sm:carlos",   label: "Carlos 2",  description: "Male" },
  { id: "sm:diego",    label: "Diego",     description: "Male" },
  { id: "sm:javier",   label: "Javier",    description: "Male" },
  { id: "sm:jose",     label: "Jose",      description: "Male" },
  { id: "sm:luis",     label: "Luis",      description: "Male" },
  { id: "sm:miguel",   label: "Miguel",    description: "Male" },
  // Lightning v2 extras (different model — worth trying if v3.1 isn't right)
  { id: "sm2:isabel",  label: "Isabel",    description: "Female" },
  { id: "sm2:gerard",  label: "Gerard",    description: "Male" },
];

// Smallest.ai Lightning v2 — European voices (2 per language, F + M).
const frenchSmallestSpeakers: SpeakerOption[] = [
  { id: "sm2:claire",   label: "Claire",   description: "Female" },
  { id: "sm2:emmanuel", label: "Emmanuel", description: "Male" },
];

const germanSmallestSpeakers: SpeakerOption[] = [
  { id: "sm2:adele", label: "Adele", description: "Female" },
  { id: "sm2:leon",  label: "Leon",  description: "Male" },
];

const italianSmallestSpeakers: SpeakerOption[] = [
  { id: "sm2:maria", label: "Maria", description: "Female" },
  { id: "sm2:enzo",  label: "Enzo",  description: "Male" },
];

const dutchSmallestSpeakers: SpeakerOption[] = [
  { id: "sm2:adriana", label: "Adriana", description: "Female" },
  { id: "sm2:lukas",   label: "Lukas",   description: "Male" },
];

const creoleSpeakers: SpeakerOption[] = [
  { id: "Pierre", label: "Pierre", description: "Male" },
  { id: "Marie", label: "Marie", description: "Female" },
];

const frenchSpeakers: SpeakerOption[] = [
  { id: "Jacques", label: "Jacques", description: "Male" },
  { id: "Camille", label: "Camille", description: "Female" },
  ...frenchSmallestSpeakers,
];

const spanishSpeakers: SpeakerOption[] = [
  { id: "Carlos", label: "Carlos", description: "Male" },
  { id: "Isabella", label: "Isabella", description: "Female" },
  ...spanishSmallestSpeakers,
];

const englishSpeakers: SpeakerOption[] = [
  { id: "Adam", label: "Adam", description: "Male" },
  { id: "River", label: "River", description: "Female" },
  ...englishSmallestSpeakers,
];

function getSpeakersForLanguage(language?: string): SpeakerOption[] {
  switch (language) {
    case "ht": return creoleSpeakers;
    case "fr": return frenchSpeakers;
    case "es": return spanishSpeakers;
    case "en": return englishSpeakers;
    case "de": return germanSmallestSpeakers;
    case "it": return italianSmallestSpeakers;
    case "nl": return dutchSmallestSpeakers;
    default: return englishSpeakers;
  }
}

export function getDefaultSpeaker(language: string): SpeakerVoice {
  switch (language) {
    case "ht": return "Pierre";
    case "fr": return "Camille";
    case "es": return "Isabella";
    case "en": return "Adam";
    case "de": return "sm2:adele";
    case "it": return "sm2:maria";
    case "nl": return "sm2:adriana";
    default: return "Adam";
  }
}

/** Sample text in each language for voice preview.
 *  Unified script: greeting + creative invitation, so every voice says the
 *  same thing and can be compared apples-to-apples. */
function getSampleText(speakerName: string, language: string): string {
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
