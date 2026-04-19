import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { callPhase } from "@/hooks/generation/callPhase";
import { createScopedLogger } from "@/lib/logger";
import type { Scene } from "@/hooks/generation/types";
import type { Json } from "@/integrations/supabase/types";

const log = createScopedLogger("CinematicRegeneration");

type CinematicScene = Pick<Scene, "number" | "voiceover" | "visualPrompt" | "videoUrl" | "audioUrl" | "imageUrl" | "duration">;

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
        .update({ scenes: nextScenes as unknown as Json })
        .eq("id", generationId);
      if (error) throw error;
    },
    [generationId]
  );

  // ── Audio regeneration → worker ──────────────────────────────────────────

  const regenerateAudio = useCallback(
    async (idx: number, newVoiceover: string) => {
      if (!generationId || !projectId) {
        toast.error("Error", { description: "Missing generation context" });
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

        toast.success("Audio Regenerated", { description: `Scene ${idx + 1} audio updated.` });
      } catch (error) {
        log.error("Audio regeneration error:", error);
        toast.error("Regeneration Failed", { description: error instanceof Error ? error.message : "Failed to regenerate audio" });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, persistScenes, onStopPlayback]
  );

  // ── Video regeneration → worker ──────────────────────────────────────────

  const regenerateVideo = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast.error("Error", { description: "Missing generation context" });
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
        
        toast.success("Video Regenerated", { description: `Scene ${idx + 1} video updated.` });
      } catch (error) {
        log.error("Video regeneration error:", error);
        toast.error("Regeneration Failed", { description: error instanceof Error ? error.message : "Failed to regenerate video" });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, persistScenes, onStopPlayback]
  );

  // ── Apply image edit → worker ────────────────────────────────────────────

  /**
   * Helper: after an image changes at idx, auto-regenerate affected videos.
   * - Scene idx video (this image is its start frame)
   * - Scene idx-1 video (this image is its end_image) — unless idx === 0
   */
  const regenAffectedVideos = useCallback(
    async (idx: number, updatedScenes: CinematicScene[]) => {
      const affectedIndices: number[] = [idx]; // always regen current scene
      if (idx > 0) affectedIndices.unshift(idx - 1); // previous scene uses this as end_image

      toast.success("Regenerating Videos", { description: `Updating ${affectedIndices.length} video(s) in parallel...` });

      // Run all affected video regens in parallel (not sequential)
      const results = await Promise.allSettled(
        affectedIndices.map(vidIdx =>
          callPhase({ phase: "video", generationId, projectId, sceneIndex: vidIdx, regenerate: true }, 10 * 60 * 1000)
        )
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const vidIdx = affectedIndices[i];
        if (r.status === "fulfilled" && r.value?.success && r.value.videoUrl) {
          updatedScenes = updatedScenes.map((s, j) =>
            j === vidIdx ? { ...s, videoUrl: r.value.videoUrl } : s
          );
        } else if (r.status === "rejected") {
          log.warn(`Video regen for scene ${vidIdx} failed:`, r.reason);
        }
      }
      onScenesUpdate(updatedScenes);
      toast.success("Videos Updated", { description: `${affectedIndices.length} video(s) regenerated.` });
    },
    [generationId, projectId, onScenesUpdate]
  );

  const applyImageEdit = useCallback(
    async (idx: number, imageModification: string) => {
      if (!generationId || !projectId) {
        toast.error("Error", { description: "Missing generation context" });
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

        // Update image + clear affected videos
        const nextScenes = scenes.map((s, i) => {
          if (i === idx) return { ...s, imageUrl: result.imageUrl, videoUrl: undefined };
          if (i === idx - 1) return { ...s, videoUrl: undefined };
          return s;
        });
        onScenesUpdate(nextScenes);

        toast.success("Image Edited", { description: `Scene ${idx + 1} updated. Regenerating affected videos...` });

        // Auto-trigger video regen for affected scenes
        await regenAffectedVideos(idx, nextScenes);
      } catch (error) {
        log.error("Image edit error:", error);
        toast.error("Image Edit Failed", { description: error instanceof Error ? error.message : "Failed to edit image" });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, regenAffectedVideos]
  );

  // ── Image regeneration → worker ──────────────────────────────────────────

  const regenerateImage = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast.error("Error", { description: "Missing generation context" });
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

        toast.success("Image Regenerated", { description: `Scene ${idx + 1} updated. Regenerating affected videos...` });

        // Auto-trigger video regen for affected scenes
        await regenAffectedVideos(idx, nextScenes);
      } catch (error) {
        log.error("Image regeneration error:", error);
        toast.error("Image Regeneration Failed", { description: error instanceof Error ? error.message : "Failed to regenerate image" });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback, regenAffectedVideos]
  );

  // ── Undo regeneration → worker ──────────────────────────────────────────

  const undoRegeneration = useCallback(
    async (idx: number) => {
      if (!generationId || !projectId) {
        toast.error("Error", { description: "Missing generation context" });
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

        toast.success("Undo Successful", { description: `Scene ${idx + 1} restored to previous state.` });
      } catch (error) {
        log.error("Undo error:", error);
        toast.error("Undo Failed", { description: error instanceof Error ? error.message : "Failed to undo" });
      } finally {
        setState({ isRegenerating: false, sceneIndex: null, type: null });
      }
    },
    [generationId, projectId, scenes, onScenesUpdate, onStopPlayback]
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
