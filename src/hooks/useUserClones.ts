import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface UserClone {
  /** user_voices row id. */
  rowId: string;
  /** External id at the TTS provider (Fish model id or ElevenLabs voice id). */
  externalId: string;
  /** Friendly name shown in the picker. */
  name: string;
  /** Provider hosting the model — drives audio router routing. */
  provider: "fish" | "elevenlabs";
  /** Prefixed id used in the SpeakerSelector dropdowns. The `clone:`
   *  prefix lets the submit handler detect that this is a custom voice
   *  and write voice_type='custom' + voice_id=<externalId> instead of
   *  treating it as one of the hardcoded SpeakerVoice union values. */
  pickerId: string;
  /** Description rendered after the name in the dropdown. */
  description: string;
}

/** Fetch the current user's cloned voices for inclusion in voice
 *  pickers. Returns an empty array for anonymous users. */
export function useUserClones() {
  const { user } = useAuth();
  return useQuery<UserClone[]>({
    queryKey: ["user-clones", user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("user_voices")
        .select("id, voice_id, voice_name, provider, description")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((row) => {
        const provider = ((row as { provider?: string }).provider as "fish" | "elevenlabs") ?? "elevenlabs";
        return {
          rowId: row.id as string,
          externalId: row.voice_id as string,
          name: row.voice_name as string,
          provider,
          pickerId: `clone:${row.voice_id as string}`,
          description: ((row as { description?: string | null }).description as string | null) || `Your cloned voice · ${provider === "fish" ? "Fish s2-pro" : "ElevenLabs"}`,
        };
      });
    },
  });
}

/** Helper for submit-time write paths — given the value selected in
 *  the speaker dropdown, returns the right project columns:
 *    - regular speaker → { voice_name, voice_type: null, voice_id: null }
 *    - cloned voice (id starts with `clone:`) → { voice_name: friendlyName,
 *      voice_type: "custom", voice_id: externalId }
 *  Caller passes the loaded UserClone[] so we can resolve the friendly
 *  name + external id from the picker prefix. */
export function resolveVoiceForProject(
  pickerValue: string,
  clones: UserClone[],
): { voice_name: string; voice_type: string | null; voice_id: string | null } {
  if (pickerValue.startsWith("clone:")) {
    const match = clones.find((c) => c.pickerId === pickerValue);
    if (match) {
      return { voice_name: match.name, voice_type: "custom", voice_id: match.externalId };
    }
  }
  return { voice_name: pickerValue, voice_type: null, voice_id: null };
}
