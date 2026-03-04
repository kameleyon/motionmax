import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface CinematicScene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  duration: number;
}

type RegenType = "audio" | "video" | "image";

interface RegenerationState {
  isRegenerating: boolean;
  sceneIndex: number | null;
  type: RegenType | null;
}

async function authenticatedFetch(path: string, body: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${path}`,
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
  if (!result.success) {
    throw new Error(result.error || "Operation failed");
  }

  return result;
}

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

  const pollUntilComplete = useCallback(
    async (idx: number, type: RegenType) => {
      if (!projectId || !generationId) return;

      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      const MAX_POLLS = 120;
      let polls = 0;
      while (polls < MAX_POLLS) {
        polls++;
        const result = await authenticatedFetch("generate-cinematic", {
          phase: type,
          projectId,
          generationId,
          sceneIndex: idx,
        });

        const nextScene = result.scene as Partial<CinematicScene>;
        onScenesUpdate(
          scenes.map((s, i) => (i === idx ? { ...s, ...nextScene } : s))
        );

        if (result.status === "complete") break;
        // 5s for video (120×5=10min coverage), 1.2s for audio
        await sleep(type === "audio" ? 1200 : 5000);
      }
      if (polls >= MAX_POLLS) {
        throw new Error("Generation timed out after maximum retries. Please try again.");
      }
    },
    [generationId, projectId, scenes, onScenesUpdate]
  );

  const regenerateAudio = useCallback(
    async (idx: number, newVoiceover: string) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "audio" });

      try {
        // Save new voiceover text first
        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, voiceover: newVoiceover } : s
        );
        onScenesUpdate(nextScenes);
        await persistScenes(nextScenes);

        // Poll until audio is complete
        await pollUntilComplete(idx, "audio");

        toast({ title: "Audio Regenerated", description: `Scene ${idx + 1} audio has been updated.` });
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
    [generationId, projectId, scenes, onScenesUpdate, persistScenes, pollUntilComplete, onStopPlayback, toast]
  );

  const regenerateVideo = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "video" });

      try {
        // Step 1: Send ONE explicit call with regenerate=true to start a new prediction
        await authenticatedFetch("generate-cinematic", {
          phase: "video",
          projectId,
          generationId,
          sceneIndex: idx,
          regenerate: true,
        });

        // Step 2: Poll for completion (never sends regenerate)
        await pollUntilComplete(idx, "video");
        toast({ title: "Video Regenerated", description: `Scene ${idx + 1} video has been updated.` });
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
    [generationId, projectId, pollUntilComplete, onStopPlayback, toast]
  );

  const applyImageEdit = useCallback(
    async (idx: number, imageModification: string) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "image" });

      try {
        const result = await authenticatedFetch("generate-cinematic", {
          phase: "image-edit",
          projectId,
          generationId,
          sceneIndex: idx,
          imageModification,
        });

        const nextScene = result.scene as Partial<CinematicScene>;
        onScenesUpdate(
          scenes.map((s, i) => (i === idx ? { ...s, ...nextScene } : s))
        );

        // Step 2: Poll video phase until Grok completes (handles timeouts/retries)
        await pollUntilComplete(idx, "video");

        toast({ title: "Image Edited", description: `Scene ${idx + 1} image edited and video regenerated.` });
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
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, toast, pollUntilComplete]
  );

  const regenerateImage = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "image" });

      try {
        const result = await authenticatedFetch("generate-cinematic", {
          phase: "image-regen",
          projectId,
          generationId,
          sceneIndex: idx,
        });

        const nextScene = result.scene as Partial<CinematicScene>;
        onScenesUpdate(
          scenes.map((s, i) => (i === idx ? { ...s, ...nextScene } : s))
        );

        // Step 2: Poll video phase until Grok completes
        await pollUntilComplete(idx, "video");

        toast({ title: "Image Regenerated", description: `Scene ${idx + 1} image and video regenerated.` });
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
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, toast, pollUntilComplete]
  );

  return {
    isRegenerating: state.isRegenerating ? { sceneIndex: state.sceneIndex!, type: state.type! } : null,
    regenerateAudio,
    regenerateVideo,
    applyImageEdit,
    regenerateImage,
  };
}
