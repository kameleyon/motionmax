import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
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

  // ── Video regeneration → worker ──────────────────────────────────────────

  const regenerateVideo = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "video" });

      try {
        const result = await callPhase({
          phase: "video",
          generationId,
          projectId,
          sceneIndex: idx,
          regenerate: true,
        }, 10 * 60 * 1000);
        
        if (!result?.success) throw new Error(result?.error || "Video regeneration failed");
        
        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, videoUrl: result.videoUrl } : s
        );
        onScenesUpdate(nextScenes);
        await persistScenes(nextScenes);
        
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
    [generationId, projectId, scenes, onScenesUpdate, persistScenes, onStopPlayback, toast]
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

        // Update image + clear stale videos:
        // - Current scene's video (this image is its start frame)
        // - Previous scene's video (this image is its end_image transition target)
        const nextScenes = scenes.map((s, i) => {
          if (i === idx) return { ...s, imageUrl: result.imageUrl, videoUrl: undefined };
          if (i === idx - 1) return { ...s, videoUrl: undefined };
          return s;
        });
        onScenesUpdate(nextScenes);

        const affectedCount = idx > 0 ? 2 : 1;
        toast({
          title: "Image Edited",
          description: `Scene ${idx + 1} image updated. ${affectedCount} video(s) need regeneration — press Render when done editing.`,
        });
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

        // Update image + clear stale videos (current + previous scene)
        const nextScenes = scenes.map((s, i) => {
          if (i === idx) return { ...s, imageUrl: result.imageUrl, videoUrl: undefined };
          if (i === idx - 1) return { ...s, videoUrl: undefined };
          return s;
        });
        onScenesUpdate(nextScenes);

        const affectedCount = idx > 0 ? 2 : 1;
        toast({
          title: "Image Regenerated",
          description: `Scene ${idx + 1} image updated. ${affectedCount} video(s) need regeneration — press Render when done editing.`,
        });
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

  // ── Undo regeneration → worker ──────────────────────────────────────────

  const undoRegeneration = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast({ variant: "destructive", title: "Error", description: "Missing generation context" });
        return;
      }

      onStopPlayback?.();
      setState({ isRegenerating: true, sceneIndex: idx, type: "image" }); // Using image type for generic loading state

      try {
        const result = await callPhase({
          phase: "undo",
          generationId,
          projectId,
          sceneIndex: idx,
        }, 30 * 1000);

        if (!result?.success) throw new Error(result?.error || "Undo failed");

        const nextScenes = scenes.map((s, i) =>
          i === idx ? { ...s, ...result.scene } : s
        );
        onScenesUpdate(nextScenes);

        toast({ title: "Undo Successful", description: `Scene ${idx + 1} restored to previous state.` });
      } catch (error) {
        console.error("Undo error:", error);
        toast({
          variant: "destructive",
          title: "Undo Failed",
          description: error instanceof Error ? error.message : "Failed to undo",
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
    undoRegeneration,
  };
}
