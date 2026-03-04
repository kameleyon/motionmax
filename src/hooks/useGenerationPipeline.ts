/**
 * Generation pipeline orchestrator hook.
 * Delegates to focused sub-modules for cinematic and standard pipelines.
 */
import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { callPhase } from "./generation/callPhase";
import { runCinematicPipeline, resumeCinematicPipeline } from "./generation/cinematicPipeline";
import { runStandardPipeline } from "./generation/standardPipeline";
import {
  type GenerationState,
  type GenerationParams,
  type PipelineContext,
  type ProjectRow,
  SCENE_COUNTS,
  INITIAL_GENERATION_STATE,
  normalizeScenes,
  extractMeta,
} from "./generation/types";

// Re-export all types for consumers
export type { GenerationStep, Scene, CostTracking, PhaseTimings, GenerationState, GenerationParams, ProjectRow } from "./generation/types";

const LOG = "[Pipeline]";

export function useGenerationPipeline() {
  const { toast } = useToast();
  const [state, setState] = useState<GenerationState>(INITIAL_GENERATION_STATE);

  const createContext = useCallback((): PipelineContext => ({
    setState,
    callPhase,
    toast,
  }), [toast]);

  const startGeneration = useCallback(async (params: GenerationParams) => {
    const expectedSceneCount = SCENE_COUNTS[params.length] || 12;
    console.log(LOG, "startGeneration", { projectType: params.projectType, length: params.length, expectedSceneCount });

    setState({
      step: "analysis",
      progress: 0,
      sceneCount: expectedSceneCount,
      currentScene: 0,
      totalImages: expectedSceneCount,
      completedImages: 0,
      isGenerating: true,
      statusMessage: "Starting generation...",
      costTracking: undefined,
      phaseTimings: undefined,
      projectType: params.projectType,
    });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("You must be logged in to generate videos");

      const ctx = createContext();
      if (params.projectType === "cinematic") {
        await runCinematicPipeline(params, ctx);
      } else {
        await runStandardPipeline(params, ctx, expectedSceneCount);
      }
    } catch (error) {
      console.error(LOG, "Generation error:", error);
      const errorMessage = error instanceof Error ? error.message : "Generation failed";
      setState((prev) => ({ ...prev, step: "error", isGenerating: false, error: errorMessage, statusMessage: errorMessage }));
      toast({ variant: "destructive", title: "Generation Failed", description: errorMessage });
    }
  }, [toast, createContext]);

  const resumeCinematic = useCallback(
    async (project: ProjectRow, generationId: string, existingScenes: any[], resumeFrom: "audio" | "images" | "video" | "finalize") => {
      console.log(LOG, "resumeCinematic", { projectId: project.id, resumeFrom });
      await resumeCinematicPipeline(project, generationId, existingScenes, resumeFrom, createContext());
    },
    [createContext]
  );

  const loadProject = useCallback(async (projectId: string): Promise<ProjectRow | null> => {
    console.log(LOG, "loadProject", { projectId });
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    if (!userId) {
      toast({ variant: "destructive", title: "Not signed in", description: "Please sign in." });
      return null;
    }

    setState((prev) => ({ ...prev, step: "analysis", progress: 0, isGenerating: true, error: undefined, projectId }));

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,title,content,format,length,style,presenter_focus,character_description,voice_type,voice_id,voice_name,brand_mark,character_consistency_enabled,inspiration_style,story_tone,story_genre,voice_inclination,project_type")
      .eq("id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (projectError || !project) {
      const msg = projectError?.message || "Project not found.";
      console.error(LOG, "loadProject failed:", msg);
      toast({ variant: "destructive", title: "Could not load project", description: msg });
      setState((prev) => ({ ...prev, step: "error", isGenerating: false, error: msg }));
      return null;
    }

    const { data: generation } = await supabase
      .from("generations")
      .select("id,status,progress,scenes,error_message,video_url")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log(LOG, "loadProject: generation", { status: generation?.status, projectType: project.project_type });

    if (generation?.status === "complete") {
      const scenes = normalizeScenes(generation.scenes) ?? [];
      const meta = extractMeta(Array.isArray(generation.scenes) ? generation.scenes : []);
      const isCinematic = project.project_type === "cinematic";

      if (isCinematic && scenes.length > 0 && scenes.some((s) => !s.videoUrl && s.imageUrl)) {
        console.log(LOG, "Auto-resuming cinematic video phase");
        void resumeCinematic(project, generation.id, scenes, "video");
      } else {
        setState({
          step: "complete", progress: 100, sceneCount: scenes.length, currentScene: scenes.length,
          totalImages: meta.totalImages || scenes.length, completedImages: meta.completedImages || scenes.length,
          isGenerating: false, projectId, generationId: generation.id, title: project.title,
          scenes, format: project.format as "landscape" | "portrait" | "square",
          finalVideoUrl: isCinematic ? (generation.video_url ?? undefined) : undefined,
          costTracking: meta.costTracking, phaseTimings: meta.phaseTimings, totalTimeMs: meta.totalTimeMs,
          projectType: (project.project_type as GenerationState["projectType"]) ?? undefined,
        });
      }
    } else if (generation?.status === "error") {
      const errorScenes = normalizeScenes(generation.scenes) ?? [];
      if (project.project_type === "cinematic" && errorScenes.length > 0) {
        const allAudio = errorScenes.every((s) => !!s.audioUrl);
        const allImages = errorScenes.every((s) => !!s.imageUrl);
        const allVideo = errorScenes.every((s) => !!s.videoUrl);
        await supabase.from("generations").update({ status: "processing", error_message: null }).eq("id", generation.id);
        if (allVideo) void resumeCinematic(project, generation.id, errorScenes, "finalize");
        else if (allImages) void resumeCinematic(project, generation.id, errorScenes, "video");
        else if (allAudio) void resumeCinematic(project, generation.id, errorScenes, "images");
        else void resumeCinematic(project, generation.id, errorScenes, "audio");
      } else {
        const msg = generation.error_message || "Generation failed";
        setState((prev) => ({
          ...prev, step: "error", isGenerating: false, error: msg,
          projectId, generationId: generation.id, title: project.title,
          format: project.format as "landscape" | "portrait" | "square",
        }));
      }
    } else if (generation && project.project_type === "cinematic") {
      const scenes = normalizeScenes(generation.scenes) ?? [];
      if (scenes.length === 0) {
        setState({
          step: "error", progress: 0, sceneCount: 0, currentScene: 0,
          totalImages: 0, completedImages: 0, isGenerating: false,
          projectId, generationId: generation.id, title: project.title,
          format: project.format as "landscape" | "portrait" | "square",
          error: "This generation was interrupted before the script completed. Please try again.",
        });
      } else {
        const allAudio = scenes.every((s) => !!s.audioUrl);
        const allImages = scenes.every((s) => !!s.imageUrl);
        const allVideo = scenes.every((s) => !!s.videoUrl);
        if (allVideo) void resumeCinematic(project, generation.id, scenes, "finalize");
        else if (allImages) void resumeCinematic(project, generation.id, scenes, "video");
        else if (allAudio) void resumeCinematic(project, generation.id, scenes, "images");
        else void resumeCinematic(project, generation.id, scenes, "audio");
      }
    } else if (generation) {
      setState({
        step: "error", progress: 0, sceneCount: state.sceneCount,
        currentScene: 0, totalImages: state.sceneCount, completedImages: 0,
        isGenerating: false, projectId, generationId: generation.id,
        title: project.title, format: project.format as "landscape" | "portrait" | "square",
        error: "This generation was interrupted. Please try again.",
      });
    } else {
      setState((prev) => ({
        ...prev, step: "idle", progress: 0, isGenerating: false,
        projectId, title: project.title, format: project.format as "landscape" | "portrait" | "square",
      }));
    }

    return project;
  }, [toast, state.sceneCount, resumeCinematic]);

  const reset = useCallback(() => {
    console.log(LOG, "reset");
    setState(INITIAL_GENERATION_STATE);
  }, []);

  return { state, startGeneration, reset, loadProject };
}
