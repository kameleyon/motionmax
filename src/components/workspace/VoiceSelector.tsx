import { useState, useRef } from "react";
import { User, UserRound, Mic, Play, Pause } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type VoiceGender = "male" | "female";

export interface VoiceSelection {
  type: "standard" | "custom";
  gender?: VoiceGender;
  voiceId?: string;
  voiceName?: string;
}

interface VoiceSelectorProps {
  selected: VoiceSelection;
  onSelect: (voice: VoiceSelection) => void;
}

interface UserVoice {
  id: string;
  voice_name: string;
  voice_id: string;
  sample_url: string;
}

const standardVoices: { id: VoiceGender; label: string; icon: typeof User }[] = [
  { id: "male", label: "Male", icon: User },
  { id: "female", label: "Female", icon: UserRound },
];

export function VoiceSelector({ selected, onSelect }: VoiceSelectorProps) {
  const { user } = useAuth();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  
  // Fetch user's custom voices
  const { data: customVoices = [] } = useQuery({
    queryKey: ["user-voices", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("user_voices")
        .select("id, voice_name, voice_id, sample_url")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      
      if (error) return [];
      return data as UserVoice[];
    },
    enabled: !!user?.id,
  });

  const togglePreview = (e: React.MouseEvent, voice: UserVoice) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (playingVoiceId === voice.voice_id) {
      audioRef.current?.pause();
      setPlayingVoiceId(null);
      return;
    }
    
    if (audioRef.current) audioRef.current.pause();
    
    if (!voice.sample_url) return;
    const audio = new Audio(voice.sample_url);
    audioRef.current = audio;
    audio.onended = () => setPlayingVoiceId(null);
    audio.play();
    setPlayingVoiceId(voice.voice_id);
  };

  const hasCustomVoices = customVoices.length > 0;

  // For simple selection (no custom voices), use buttons
  if (!hasCustomVoices) {
    return (
      <div className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Voice</h3>
        <div className="flex gap-2">
          {standardVoices.map((voice) => {
            const Icon = voice.icon;
            const isSelected = selected.type === "standard" && selected.gender === voice.id;

            return (
              <motion.button
                key={voice.id}
                onClick={() => onSelect({ type: "standard", gender: voice.id })}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-4 py-2.5 transition-all",
                  isSelected
                    ? "border-primary/50 bg-primary/5 shadow-sm"
                    : "border-transparent dark:border-white/10 bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15 hover:border-border"
                )}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
              >
                <Icon className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")} />
                <span className={cn(
                  "text-sm font-medium",
                  isSelected ? "text-foreground" : "text-muted-foreground"
                )}>{voice.label}</span>
              </motion.button>
            );
          })}
        </div>
      </div>
    );
  }

  // With custom voices, use a grouped dropdown
  const getDisplayValue = () => {
    if (selected.type === "custom" && selected.voiceName) {
      return selected.voiceName;
    }
    if (selected.type === "standard" && selected.gender) {
      return selected.gender === "male" ? "Male Voice" : "Female Voice";
    }
    return "Select voice";
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Voice</h3>
      <Select
        value={selected.type === "custom" ? `custom-${selected.voiceId}` : `standard-${selected.gender}`}
        onValueChange={(value) => {
          if (value.startsWith("standard-")) {
            const gender = value.replace("standard-", "") as VoiceGender;
            onSelect({ type: "standard", gender });
          } else if (value.startsWith("custom-")) {
            const voiceId = value.replace("custom-", "");
            const voice = customVoices.find(v => v.voice_id === voiceId);
            if (voice) {
              onSelect({ 
                type: "custom", 
                voiceId: voice.voice_id, 
                voiceName: voice.voice_name 
              });
            }
          }
        }}
      >
        <SelectTrigger className="w-full rounded-xl border-border/50 bg-muted/50">
          <SelectValue placeholder="Select a voice">
            {getDisplayValue()}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {/* Custom Voices Group */}
          <SelectGroup>
            <SelectLabel className="flex items-center gap-2 text-xs">
              <Mic className="h-3 w-3" />
              My Voices
            </SelectLabel>
            {customVoices.map((voice) => (
              <SelectItem 
                key={voice.id} 
                value={`custom-${voice.voice_id}`}
                className="cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  {voice.sample_url ? (
                    <button
                      type="button"
                      onPointerDown={(e) => togglePreview(e, voice)}
                      className="p-0.5 rounded hover:bg-muted/50"
                    >
                      {playingVoiceId === voice.voice_id ? (
                        <Pause className="h-3.5 w-3.5 text-primary" />
                      ) : (
                        <Play className="h-3.5 w-3.5 text-primary" />
                      )}
                    </button>
                  ) : (
                    <Mic className="h-3.5 w-3.5 text-primary" />
                  )}
                  {voice.voice_name}
                </div>
              </SelectItem>
            ))}
          </SelectGroup>

          {/* Standard Voices Group */}
          <SelectGroup>
            <SelectLabel className="text-xs">Standard Voices</SelectLabel>
            {standardVoices.map((voice) => {
              const Icon = voice.icon;
              return (
                <SelectItem 
                  key={voice.id} 
                  value={`standard-${voice.id}`}
                  className="cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {voice.label} Voice
                  </div>
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
