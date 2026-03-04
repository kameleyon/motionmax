import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { Scene } from "@/hooks/useGenerationPipeline";

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

  const regenerateAudio = useCallback(
    async (sceneIndex: number, newVoiceover: string) => {
      if (!generationId || !projectId || !scenes) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Missing generation context",
        });
        return;
      }

      setState({ isRegenerating: true, regeneratingType: "audio", sceneIndex });

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-video`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              phase: "regenerate-audio",
              generationId,
              projectId,
              sceneIndex,
              newVoiceover,
            }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to regenerate audio");
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Audio regeneration failed");
        }

        // Update local scenes with new audio
        const updatedScenes = [...scenes];
        updatedScenes[sceneIndex] = {
          ...updatedScenes[sceneIndex],
          voiceover: newVoiceover,
          audioUrl: result.audioUrl,
          duration: result.duration || updatedScenes[sceneIndex].duration,
        };

        onScenesUpdate(updatedScenes);

        toast({
          title: "Audio Regenerated",
          description: `Scene ${sceneIndex + 1} audio has been updated.`,
        });
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

  const regenerateImage = useCallback(
    async (sceneIndex: number, imageModification: string, imageIndex?: number) => {
      if (!generationId || !projectId || !scenes) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Missing generation context",
        });
        return;
      }

      setState({ isRegenerating: true, regeneratingType: "image", sceneIndex });

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-video`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              phase: "regenerate-image",
              generationId,
              projectId,
              sceneIndex,
              imageModification,
              imageIndex: imageIndex ?? 0, // Default to first image if not specified
            }),
          }
        );

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to regenerate image");
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Image regeneration failed");
        }

        // Update local scenes with new image(s)
        const updatedScenes = [...scenes];
        
        // If we have imageUrls and a specific imageIndex, update just that image
        if (result.imageUrl && typeof imageIndex === 'number' && updatedScenes[sceneIndex].imageUrls?.length) {
          const newImageUrls = [...updatedScenes[sceneIndex].imageUrls!];
          newImageUrls[imageIndex] = result.imageUrl;
          updatedScenes[sceneIndex] = {
            ...updatedScenes[sceneIndex],
            imageUrls: newImageUrls,
            imageUrl: imageIndex === 0 ? result.imageUrl : updatedScenes[sceneIndex].imageUrl,
          };
        } else {
          // Fallback: replace all images (for full regeneration or single-image scenes)
          updatedScenes[sceneIndex] = {
            ...updatedScenes[sceneIndex],
            imageUrl: result.imageUrl,
            imageUrls: result.imageUrls || [result.imageUrl],
          };
        }

        onScenesUpdate(updatedScenes);

        toast({
          title: "Image Regenerated",
          description: `Scene ${sceneIndex + 1}${typeof imageIndex === 'number' ? ` image ${imageIndex + 1}` : ''} has been updated.`,
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
