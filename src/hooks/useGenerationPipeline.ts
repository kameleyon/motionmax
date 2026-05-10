/**
 * Generation pipeline orchestrator hook.
 * Delegates to focused sub-modules for cinematic and standard pipelines.
 *
 * Abort mechanism: a `generationEpoch` ref increments on every reset or
 * project switch. The pipeline context's `setState` wrapper silently
 * discards updates from stale epochs, preventing old pipelines from
 * overwriting the current project's state.
 */
import { useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/databaseService";
import { toast as sonnerToast } from "sonner";
import { createScopedLogger } from "@/lib/logger";
import { breadcrumbGenerationStart } from "@/lib/sentryBreadcrumbs";
import { startGenerationTrace, shortTraceRef } from "@/lib/tracing";
import { trackEvent } from "@/hooks/useAnalytics";
import { EVENTS } from "@/lib/events";
import { callPhase } from "./generation/callPhase";
import { resumeCinematicPipeline } from "./generation/cinematicPipeline";
import { runUnifiedPipeline } from "./generation/unifiedPipeline";
import {
  type GenerationState,
  type GenerationParams,
  type PipelineContext,
  type ProjectRow,
  type Scene,
  SCENE_COUNTS,
  INITIAL_GENERATION_STATE,
  normalizeScenes,
  extractMeta,
} from "./generation/types";

// Re-export all types for consumers
export type { GenerationStep, Scene, CostTracking, PhaseTimings, GenerationState, GenerationParams, ProjectRow } from "./generation/types";

const log = createScopedLogger("Pipeline");

export function useGenerationPipeline() {
  const [state, setState] = useState<GenerationState>(INITIAL_GENERATION_STATE);

  // Epoch counter: increments on every reset / project switch.
  // Pipeline contexts capture the current epoch; if it changes, their
  // setState calls become no-ops so stale pipelines can't clobber state.
  const epochRef = useRef(0);

  // Ref to avoid loadProject depending on state.sceneCount (which changes
  // during generation and would recreate loadProject, causing polling storms).
  const sceneCountRef = useRef(state.sceneCount);
  sceneCountRef.current = state.sceneCount;

  /** Create a pipeline context whose setState is scoped to the current epoch. */
  const createContext = useCallback((traceId?: string): PipelineContext => {
    const epoch = epochRef.current;
    return {
      setState: (updater) => {
        if (epochRef.current !== epoch) {
          log.debug("Stale pipeline setState ignored (epoch mismatch)");
          return;
        }
        setState(updater);
      },
      // Audit C-9-6: wrap callPhase so every phase body carries the
      // generation-lifecycle trace ID. The worker pulls
      // `payload.traceId` into Sentry as a tag already; this is the
      // missing client-side half.
      callPhase: (body, timeoutMs, endpoint) =>
        callPhase(
          traceId ? { ...body, traceId, _trace_id: traceId } : body,
          timeoutMs,
          endpoint,
        ),
      traceId,
      toast: (opts) => {
        if (opts.variant === "destructive") {
          sonnerToast.error(opts.title || "Error", { description: opts.description });
        } else {
          sonnerToast.success(opts.title || "", { description: opts.description });
        }
      },
    };
  }, []);

  const startGeneration = useCallback(async (params: GenerationParams) => {
    const expectedSceneCount = SCENE_COUNTS[params.length] || 12;
    log.debug("startGeneration", { projectType: params.projectType, length: params.length, expectedSceneCount });
    breadcrumbGenerationStart({
      projectId: params.projectId ?? "new",
      projectType: params.projectType,
      creditCost: expectedSceneCount,
    });

    // §11 Lens C2 — fire client-side activation event + mirror server-side
    // to funnel_events so the admin funnel can count it without depending on
    // GA4. project_id is best-effort (may be undefined for brand-new submits
    // — IntakeForm now seeds it via create_project_idempotent).
    const genStartedAt = Date.now();
    try {
      trackEvent(EVENTS.generation_started, {
        project_id: params.projectId ?? "(pending)",
        task_type: params.projectType ?? "doc2video",
        length: params.length,
      });
    } catch { /* analytics non-critical */ }
    // Fire-and-forget RPC mirror. Worker also writes first_generation_started
    // when it starts processing the script job, so a network error here is
    // tolerable — we may miss the click-to-start lag but not the cohort.
    void (supabase.rpc as unknown as (
      fn: string, args: Record<string, unknown>,
    ) => Promise<unknown>)("record_funnel_event", {
      p_stage: "first_generation_started",
      p_props: {
        project_id: params.projectId ?? null,
        task_type: params.projectType ?? "doc2video",
        length: params.length,
      },
    }).then(() => {}, () => {});

    // Bump epoch to abort any stale pipeline
    epochRef.current++;

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
      // Seed projectId from the kickoff params so realtime subscriptions
      // + progress hooks tie to the existing project row immediately.
      // Without this, projectId only becomes known after the script
      // phase returns — a window where the editor polls against a
      // projectId it technically already has.
      projectId: params.projectId,
    });

    // Audit C-9-6: start a Sentry-correlated trace for the whole generation
    // lifecycle. The ID flows down through PipelineContext.callPhase into
    // every phase body (and thence into worker job.payload.traceId), and
    // surfaces in user-facing error toasts as a 8-char ref.
    const { traceId, end: endTrace } = startGenerationTrace(
      `generation.${params.projectType ?? "doc2video"}.${params.length}`,
    );

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("You must be logged in to generate videos");

      const ctx = createContext(traceId);
      await runUnifiedPipeline(params, ctx, expectedSceneCount);
    } catch (error) {
      log.error("Generation error:", error);
      const rawMsg = error instanceof Error ? error.message : "Generation failed";
      // Don't double-print the ref if a downstream layer already attached one.
      const errorMessage = rawMsg.includes("(Ref:")
        ? rawMsg
        : `${rawMsg} (Ref: ${shortTraceRef(traceId)})`;
      setState((prev) => ({ ...prev, step: "error", isGenerating: false, error: errorMessage, statusMessage: errorMessage }));
      sonnerToast.error("Generation Failed", { description: errorMessage });

      // §11 Lens C2 — terminal-failure event. error_class is the message
      // prefix only (no tail / no PII) so the GA4 dimension stays low-card.
      try {
        const errorClass = rawMsg.split(/[:.(]/)[0]?.trim().slice(0, 64) || "unknown";
        trackEvent(EVENTS.generation_failed, {
          project_id: params.projectId ?? "(none)",
          task_type: params.projectType ?? "doc2video",
          error_class: errorClass,
          duration_ms: Date.now() - genStartedAt,
        });
      } catch { /* analytics non-critical */ }
    } finally {
      endTrace();
    }
  }, [createContext]);

  const resumeCinematic = useCallback(
    async (project: ProjectRow, generationId: string, existingScenes: Scene[], resumeFrom: "audio" | "images" | "video" | "finalize") => {
      log.debug("resumeCinematic", { projectId: project.id, resumeFrom });
      await resumeCinematicPipeline(project, generationId, existingScenes, resumeFrom, createContext());
    },
    [createContext]
  );

  const loadProject = useCallback(async (projectId: string): Promise<ProjectRow | null> => {
    log.debug("loadProject", { projectId });

    // Bump epoch to abort any running pipeline from previous project
    epochRef.current++;

    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    if (!userId) {
      sonnerToast.error("Not signed in", { description: "Please sign in." });
      return null;
    }

    setState((prev) => ({ ...prev, step: "analysis", progress: 0, isGenerating: true, error: undefined, projectId }));

    const { data: projectRows, error: projectError } = await db.query("projects", (q) =>
      q.eq("id", projectId).eq("user_id", userId).limit(1)
    );
    const project = projectRows?.[0] as ProjectRow | undefined;

    if (projectError || !project) {
      const msg = projectError || "Project not found.";
      log.error("loadProject failed:", msg);
      sonnerToast.error("Could not load project", { description: msg });
      setState((prev) => ({ ...prev, step: "error", isGenerating: false, error: msg }));
      return null;
    }

    const { data: generationRows } = await db.query("generations", (q) =>
      q.eq("project_id", projectId).order("created_at", { ascending: false }).limit(1)
    );
    const generation = generationRows?.[0] as { id: string; status: string; progress: number; scenes: unknown; error_message: string | null; video_url: string | null } | undefined;

    log.debug("loadProject: generation", { status: generation?.status, projectType: project.project_type });

    if (generation?.status === "complete") {
      const scenes = normalizeScenes(generation.scenes) ?? [];
      const meta = extractMeta(Array.isArray(generation.scenes) ? generation.scenes : []);
      const isCinematic = project.project_type === "cinematic";

      if (isCinematic && scenes.length > 0 && scenes.some((s) => !s.videoUrl && s.imageUrl)) {
        log.debug("Auto-resuming cinematic video phase");
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
        await db.update("generations", { status: "processing", error_message: null }, (q) => q.eq("id", generation.id));
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
        step: "error", progress: 0, sceneCount: sceneCountRef.current,
        currentScene: 0, totalImages: sceneCountRef.current, completedImages: 0,
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
  }, [resumeCinematic]);

  const reset = useCallback(() => {
    log.debug("reset");
    // Bump epoch so any running pipeline's setState calls become no-ops
    epochRef.current++;
    setState(INITIAL_GENERATION_STATE);
  }, []);

  return { state, startGeneration, reset, loadProject };
}
