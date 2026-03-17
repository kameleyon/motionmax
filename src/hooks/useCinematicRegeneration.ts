import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { SUPABASE_URL } from "@/lib/supabaseUrl";
import { callPhase } from "@/hooks/generation/callPhase";

interface CinematicScene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  imageUrl?: string;
  duration: number;
}

type RegenType = "audio" | "video" | "image";

interface RegenerationState {
  isRegenerating: boolean;
  sceneIndex: number | null;
  type: RegenType | null;
}

// ── Cinematic video polling (edge function for Kling/Wan video gen) ─────────

async function cinematicVideoFetch(path: string, body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const response = await fetch(
    `${SUPABASE_URL}/functions/v1/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }

  const result = await response.json();
  if (!result.success) throw new Error(result.error || "Operation failed");
  return result;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCinematicRegeneration(
  generationId: string | undefined,
  projectId: string | undefined,
  scenes: CinematicScene[],
  onScenesUpdate: (scenes: CinematicScene[]) => void,
  onStopPlayback?: () => void
) {
  const { toast } = useToast();
  const [state, setState] = useState<RegenerationState>({
    isRegenerating: false,
    sceneIndex: null,
    type: null,
  });

  const persistScenes = useCallback(
    async (nextScenes: CinematicScene[]) => {
      if (!generationId) return;
      const { error } = await supabase
        .from("generations")
        .update({ scenes: nextScenes as any })
        .eq("id", generationId);
      if (error) throw error;
    },
    [generationId]
  );

  // Video polling via edge function (cinematic-specific video rendering)
  const pollVideoPhase = useCallback(
    async (idx: number) => {
      if (!projectId || !generationId) return;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const MAX_POLLS = 120;
      let polls = 0;
      while (polls < MAX_POLLS) {
        polls++;
        const result = await cinematicVideoFetch("generate-cinematic", {
          phase: "video",
          projectId,
          generationId,
          sceneIndex: idx,
        });
        const nextScene = result.scene as Partial<CinematicScene>;
        onScenesUpdate(scenes.map((s, i) => (i === idx ? { ...s, ...nextScene } : s)));
        if (result.status === "complete") break;
        await sleep(5000);
      }
      if (polls >= MAX_POLLS) throw new Error("Video generation timed out. Please try again.");
    },
    [generationId, projectId, scenes, onScenesUpdate]
  );

  // ── Audio regeneration → worker ──────────────────────────────────────────

  const regenerateAudio = useCallback(
    async (idx: number, newVoiceover: string) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "audio" });

      try {
        const result = await callPhase({
          phase: "regenerate-audio",
          generationId,
          projectId,
          sceneIndex: idx,
          newVoiceover,
        }, 3 * 60 * 1000);

        if (!result?.success) throw new Error(result?.error || "Audio regeneration failed");

        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, voiceover: newVoiceover, audioUrl: result.audioUrl, duration: result.duration || s.duration } : s
        );
        onScenesUpdate(nextScenes);
        await persistScenes(nextScenes);

        toast({ title: "Audio Regenerated", description: `Scene ${idx + 1} audio updated.` });
      } catch (error) {
        console.error("Audio regeneration error:", error);
        toast({
          variant: "destructive",
          title: "Regeneration Failed",
          description: error instanceof Error ? error.message : "Failed to regenerate audio",
        });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, persistScenes, onStopPlayback, toast]
  );

  // ── Video regeneration → cinematic edge function ─────────────────────────

  const regenerateVideo = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "video" });

      try {
        await cinematicVideoFetch("generate-cinematic", {
          phase: "video",
          projectId,
          generationId,
          sceneIndex: idx,
          regenerate: true,
        });
        await pollVideoPhase(idx);
        toast({ title: "Video Regenerated", description: `Scene ${idx + 1} video updated.` });
      } catch (error) {
        console.error("Video regeneration error:", error);
        toast({
          variant: "destructive",
          title: "Regeneration Failed",
          description: error instanceof Error ? error.message : "Failed to regenerate video",
        });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, pollVideoPhase, onStopPlayback, toast]
  );

  // ── Apply image edit → worker ────────────────────────────────────────────

  const applyImageEdit = useCallback(
    async (idx: number, imageModification: string) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "image" });

      try {
        const result = await callPhase({
          phase: "regenerate-image",
          generationId,
          projectId,
          sceneIndex: idx,
          imageIndex: 0,
          imageModification,
        }, 3 * 60 * 1000);

        if (!result?.success) throw new Error(result?.error || "Image edit failed");

        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, imageUrl: result.imageUrl } : s
        );
        onScenesUpdate(nextScenes);

        toast({ title: "Image Edited", description: `Scene ${idx + 1} image updated.` });
      } catch (error) {
        console.error("Image edit error:", error);
        toast({
          variant: "destructive",
          title: "Image Edit Failed",
          description: error instanceof Error ? error.message : "Failed to edit image",
        });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, toast]
  );

  // ── Image regeneration → worker ──────────────────────────────────────────

  const regenerateImage = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "image" });

      try {
        const result = await callPhase({
          phase: "regenerate-image",
          generationId,
          projectId,
          sceneIndex: idx,
          imageIndex: 0,
          imageModification: "",
        }, 3 * 60 * 1000);

        if (!result?.success) throw new Error(result?.error || "Image regeneration failed");

        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, imageUrl: result.imageUrl } : s
        );
        onScenesUpdate(nextScenes);

        toast({ title: "Image Regenerated", description: `Scene ${idx + 1} image updated.` });
      } catch (error) {
        console.error("Image regeneration error:", error);
        toast({
          variant: "destructive",
          title: "Image Regeneration Failed",
          description: error instanceof Error ? error.message : "Failed to regenerate image",
        });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, toast]
  );

  return {
    isRegenerating: state.isRegenerating ? { sceneIndex: state.sceneIndex!, type: state.type! } : null,
    regenerateAudio,
    regenerateVideo,
    applyImageEdit,
    regenerateImage,
  };
}
