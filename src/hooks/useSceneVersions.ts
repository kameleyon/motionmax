import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SceneVersion {
  id: string;
  generation_id: string;
  scene_index: number;
  voiceover: string | null;
  visual_prompt: string | null;
  image_url: string | null;
  image_urls: string[] | null;
  audio_url: string | null;
  duration: number | null;
  video_url: string | null;
  change_type: "audio" | "image" | "both" | "initial";
  created_at: string;
}

export function useSceneVersions(generationId: string | undefined, sceneIndex: number) {
  return useQuery({
    queryKey: ["scene-versions", generationId, sceneIndex],
    queryFn: async () => {
      if (!generationId) return [];

      const { data, error } = await supabase
        .from("scene_versions" as any)
        .select("*")
        .eq("generation_id", generationId)
        .eq("scene_index", sceneIndex)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Parse image_urls JSON if present
      return (data || []).map((v: any) => ({
        ...v,
        image_urls: v.image_urls ? JSON.parse(v.image_urls) : null,
      })) as SceneVersion[];
    },
    enabled: !!generationId,
    staleTime: 10000, // Cache for 10 seconds
  });
}

export function useSceneVersionCount(generationId: string | undefined, sceneIndex: number) {
  return useQuery({
    queryKey: ["scene-version-count", generationId, sceneIndex],
    queryFn: async () => {
      if (!generationId) return 0;

      const { count, error } = await supabase
        .from("scene_versions" as any)
        .select("id", { count: "exact", head: true })
        .eq("generation_id", generationId)
        .eq("scene_index", sceneIndex);

      if (error) throw error;
      return count || 0;
    },
    enabled: !!generationId,
    staleTime: 10000,
  });
}
