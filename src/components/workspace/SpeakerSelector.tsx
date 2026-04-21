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
  | "Leo" | "Maya" | "Sage" | "Aria";

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

const creoleSpeakers: SpeakerOption[] = [
  { id: "Pierre", label: "Pierre", description: "Male" },
  { id: "Marie", label: "Marie", description: "Female" },
];

const frenchSpeakers: SpeakerOption[] = [
  { id: "Jacques", label: "Jacques", description: "Male" },
  { id: "Camille", label: "Camille", description: "Female" },
];

const spanishSpeakers: SpeakerOption[] = [
  { id: "Carlos", label: "Carlos", description: "Male" },
  { id: "Isabella", label: "Isabella", description: "Female" },
];

const englishSpeakers: SpeakerOption[] = [
  { id: "Adam", label: "Adam", description: "Male" },
  { id: "River", label: "River", description: "Female" },
];

function getSpeakersForLanguage(language?: string): SpeakerOption[] {
  switch (language) {
    case "ht": return creoleSpeakers;
    case "fr": return frenchSpeakers;
    case "es": return spanishSpeakers;
    case "en": return englishSpeakers;
    default: return englishSpeakers;
  }
}

export function getDefaultSpeaker(language: string): SpeakerVoice {
  switch (language) {
    case "ht": return "Pierre";
    case "fr": return "Camille";
    case "es": return "Isabella";
    case "en": return "River";
    default: return "River";
  }
}

/** Sample text in each language for voice preview */
function getSampleText(speakerName: string, language: string): string {
  switch (language) {
    case "ht": return `Bonjou, mwen se ${speakerName}. Se konsa vwa mwen sonnen lè m ap rakonte videyo ou.`;
    case "fr": return `Bonjour, je suis ${speakerName}. Voici comment sonne ma voix pour vos vid\u00e9os.`;
    case "es": return `Hola, soy ${speakerName}. As\u00ed suena mi voz cuando narro tu video.`;
    case "pt": return `Ol\u00e1, eu sou ${speakerName}. \u00c9 assim que minha voz soa ao narrar seu v\u00eddeo.`;
    case "de": return `Hallo, ich bin ${speakerName}. So klingt meine Stimme bei der Vertonung Ihres Videos.`;
    case "it": return `Ciao, sono ${speakerName}. Ecco come suona la mia voce quando narro il tuo video.`;
    case "ru": return `\u041f\u0440\u0438\u0432\u0435\u0442, \u044f ${speakerName}. \u0422\u0430\u043a \u0437\u0432\u0443\u0447\u0438\u0442 \u043c\u043e\u0439 \u0433\u043e\u043b\u043e\u0441 \u043f\u0440\u0438 \u043e\u0437\u0432\u0443\u0447\u0438\u0432\u0430\u043d\u0438\u0438 \u0432\u0430\u0448\u0435\u0433\u043e \u0432\u0438\u0434\u0435\u043e.`;
    case "zh": return `\u4F60\u597D\uFF0C\u6211\u662F${speakerName}\u3002\u8FD9\u5C31\u662F\u6211\u4E3A\u60A8\u7684\u89C6\u9891\u89E3\u8BF4\u65F6\u7684\u58F0\u97F3\u3002`;
    case "ja": return `\u3053\u3093\u306B\u3061\u306F\u3001${speakerName}\u3067\u3059\u3002\u52D5\u753B\u306E\u30CA\u30EC\u30FC\u30B7\u30E7\u30F3\u306F\u3053\u306E\u3088\u3046\u306B\u306A\u308A\u307E\u3059\u3002`;
    case "ko": return `\uC548\uB155\uD558\uC138\uC694, ${speakerName}\uC785\uB2C8\uB2E4. \uBE44\uB514\uC624 \uB0B4\uB808\uC774\uC158 \uBAA9\uC18C\uB9AC\uC785\uB2C8\uB2E4.`;
    default: return `Hello, I'm ${speakerName}. This is how my voice sounds when narrating your video.`;
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
