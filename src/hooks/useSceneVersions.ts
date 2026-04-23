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

// scene_versions is not in the Supabase generated types — cast through unknown
type AnyTable = ReturnType<typeof supabase.from>;
const sceneVersionsTable = () => (supabase as unknown as { from: (t: string) => AnyTable }).from("scene_versions");

export function useSceneVersions(generationId: string | undefined, sceneIndex: number) {
  return useQuery({
    queryKey: ["scene-versions", generationId, sceneIndex],
    queryFn: async () => {
      if (!generationId) return [];

      const { data, error } = await sceneVersionsTable()
        .select("*")
        .eq("generation_id", generationId)
        .eq("scene_index", sceneIndex)
        .order("created_at", { ascending: false });

      if (error) throw error;

      // Legacy scene_versions rows stored image_urls as either a JSON
      // string OR a raw URL (some rows from before the column was
      // switched to jsonb). A bare URL like "https://ay..." crashes
      // JSON.parse with the "Unexpected token 'h'" the user hit on
      // restore. Parse defensively: treat a non-JSON string as a
      // single-element array so the rest of the flow still works.
      const parseImageUrls = (v: string | string[] | null | undefined): string[] | null => {
        if (v == null) return null;
        if (Array.isArray(v)) return v;
        if (typeof v !== 'string') return null;
        const trimmed = v.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try { return JSON.parse(trimmed) as string[]; } catch { return [trimmed]; }
        }
        return [trimmed];
      };

      return ((data || []) as Array<SceneVersion & { image_urls: string | string[] | null }>).map((v) => ({
        ...v,
        image_urls: parseImageUrls(v.image_urls),
      })) as SceneVersion[];
    },
    enabled: !!generationId,
    staleTime: 10000,
  });
}

export function useSceneVersionCount(generationId: string | undefined, sceneIndex: number) {
  return useQuery({
    queryKey: ["scene-version-count", generationId, sceneIndex],
    queryFn: async () => {
      if (!generationId) return 0;

      const { count, error } = await sceneVersionsTable()
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
