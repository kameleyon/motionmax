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
  ...qwenSpeakers,
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
    default: return qwenSpeakers;
  }
}

export function getDefaultSpeaker(language: string): SpeakerVoice {
  switch (language) {
    case "ht": return "Pierre";
    case "fr": return "Camille";
    case "es": return "Isabella";
    case "en": return "Nova";
    default: return "Nova";
  }
}

const CACHE_KEY = "motionmax_voice_previews";

function getCachedPreview(speakerId: string): string | null {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return cache[speakerId] || null;
  } catch { return null; }
}

function setCachedPreview(speakerId: string, url: string) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache[speakerId] = url;
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

    // Check cache first
    const cached = getCachedPreview(speaker.id);
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

      const sampleText = `Hello, I'm ${speaker.label}. This is how my voice sounds when narrating your video.`;

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
          .from("video_generation_jobs") as any)
          .select("status, result")
          .eq("id", job.id)
          .single();

        if (row?.status === "completed" && row?.result?.audioUrl) {
          const url = row.result.audioUrl;
          setCachedPreview(speaker.id, url);
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
      console.warn("Voice preview failed:", err);
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
