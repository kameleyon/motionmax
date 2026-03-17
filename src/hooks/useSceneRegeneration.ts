import { useState, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import type { Scene } from "@/hooks/useGenerationPipeline";
import { callPhase } from "@/hooks/generation/callPhase";

interface RegenerationState {
  isRegenerating: boolean;
  regeneratingType: "audio" | "image" | null;
  sceneIndex: number | null;
}

export function useSceneRegeneration(
  generationId: string | undefined,
  projectId: string | undefined,
  scenes: Scene[] | undefined,
  onScenesUpdate: (scenes: Scene[]) => void
) {
  const { toast } = useToast();
  const [state, setState] = useState<RegenerationState>({
    isRegenerating: false,
    regeneratingType: null,
    sceneIndex: null,
  });

  // ── Regenerate audio for a single scene ────────────────────────────

  const regenerateAudio = useCallback(
    async (sceneIndex: number, newVoiceover: string) => {
      if (!generationId || !projectId || !scenes) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      setState({ isRegenerating: true, regeneratingType: "audio", sceneIndex });

      try {
        // Route through worker queue (3 min poll timeout)
        const result = await callPhase(
          {
            phase: "regenerate-audio",
            generationId,
            projectId,
            sceneIndex,
            newVoiceover,
          },
          3 * 60 * 1000,
        );

        if (!result?.success) throw new Error(result?.error || "Audio regeneration failed");

        const updatedScenes = [...scenes];
        updatedScenes[sceneIndex] = {
          ...updatedScenes[sceneIndex],
          voiceover: newVoiceover,
          audioUrl: result.audioUrl,
          duration: result.duration || updatedScenes[sceneIndex].duration,
        };
        onScenesUpdate(updatedScenes);

        toast({ title: "Audio Regenerated", description: `Scene ${sceneIndex + 1} audio updated.` });
      } catch (error) {
        console.error("Audio regeneration error:", error);
        toast({
          variant: "destructive",
          title: "Regeneration Failed",
          description: error instanceof Error ? error.message : "Failed to regenerate audio",
        });
      } finally {
        setState({ isRegenerating: false, regeneratingType: null, sceneIndex: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, toast]
  );

  // ── Regenerate (or edit) a specific scene image ────────────────────

  const regenerateImage = useCallback(
    async (sceneIndex: number, imageModification: string, imageIndex?: number) => {
      if (!generationId || !projectId || !scenes) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      setState({ isRegenerating: true, regeneratingType: "image", sceneIndex });

      try {
        // Route through worker queue (3 min poll timeout)
        const result = await callPhase(
          {
            phase: "regenerate-image",
            generationId,
            projectId,
            sceneIndex,
            imageModification,
            imageIndex: imageIndex ?? 0,
          },
          3 * 60 * 1000,
        );

        if (!result?.success) throw new Error(result?.error || "Image regeneration failed");

        const updatedScenes = [...scenes];
        const targetIdx = imageIndex ?? 0;

        if (result.imageUrl && updatedScenes[sceneIndex].imageUrls?.length) {
          const newImageUrls = [...updatedScenes[sceneIndex].imageUrls!];
          newImageUrls[targetIdx] = result.imageUrl;
          updatedScenes[sceneIndex] = {
            ...updatedScenes[sceneIndex],
            imageUrls: newImageUrls,
            imageUrl: targetIdx === 0 ? result.imageUrl : updatedScenes[sceneIndex].imageUrl,
          };
        } else {
          updatedScenes[sceneIndex] = {
            ...updatedScenes[sceneIndex],
            imageUrl: result.imageUrl,
            imageUrls: result.imageUrls || [result.imageUrl],
          };
        }

        onScenesUpdate(updatedScenes);

        toast({
          title: "Image Regenerated",
          description: `Scene ${sceneIndex + 1}${typeof imageIndex === "number" ? ` image ${imageIndex + 1}` : ""} updated.`,
        });
      } catch (error) {
        console.error("Image regeneration error:", error);
        toast({
          variant: "destructive",
          title: "Regeneration Failed",
          description: error instanceof Error ? error.message : "Failed to regenerate image",
        });
      } finally {
        setState({ isRegenerating: false, regeneratingType: null, sceneIndex: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, toast]
  );

  return {
    ...state,
    regenerateAudio,
    regenerateImage,
  };
}
