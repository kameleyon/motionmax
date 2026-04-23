/**
 * Shared types and utilities for the generation pipeline.
 * Extracted from useGenerationPipeline for modularity and testability.
 */

import type { VideoFormat, VideoLength, ProductId, VisualStyle, Language } from "@/types/domain";

// ---- Types ----

export type GenerationStep =
  | "idle"
  | "analysis"
  | "scripting"
  | "visuals"
  | "rendering"
  | "complete"
  | "error";

export interface Scene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  subVisuals?: string[];
  duration: number;
  narrativeBeat?: "hook" | "conflict" | "choice" | "solution" | "formula";
  imageUrl?: string;
  imageUrls?: string[];
  audioUrl?: string;
  videoUrl?: string;
  title?: string;
  subtitle?: string;
}

export interface CostTracking {
  scriptTokens: number;
  audioSeconds: number;
  imagesGenerated: number;
  estimatedCostUsd: number;
}

export interface PhaseTimings {
  script?: number;
  audio?: number;
  images?: number;
  finalize?: number;
}

export interface GenerationState {
  step: GenerationStep;
  progress: number;
  sceneCount: number;
  currentScene: number;
  totalImages: number;
  completedImages: number;
  etaSeconds?: number; // Estimated time remaining in seconds
  isGenerating: boolean;
  projectId?: string;
  generationId?: string;
  title?: string;
  scenes?: Scene[];
  format?: "landscape" | "portrait" | "square";
  finalVideoUrl?: string;
  error?: string;
  statusMessage?: string;
  costTracking?: CostTracking;
  phaseTimings?: PhaseTimings;
  totalTimeMs?: number;
  projectType?: "doc2video" | "smartflow" | "cinematic";
}

export interface GenerationParams {
  /** Existing project row ID — passed through the script job payload
   *  so the worker's `handleGenerateVideo` reuses it instead of
   *  creating a phantom duplicate. Omitting this (legacy workspaces)
   *  makes the worker insert a brand-new project. */
  projectId?: string;
  content: string;
  format: VideoFormat;
  length: VideoLength;
  style: VisualStyle | string;
  customStyle?: string;
  customStyleImage?: string | null;
  brandMark?: string;
  presenterFocus?: string;
  characterDescription?: string;
  characterImages?: string[];
  disableExpressions?: boolean;
  characterConsistencyEnabled?: boolean;
  voiceType?: "standard" | "custom";
  voiceId?: string;
  voiceName?: string;
  projectType?: ProductId;
  inspirationStyle?: string;
  storyTone?: string;
  storyGenre?: string;
  voiceInclination?: string;
  brandName?: string;
  language?: Language | string;
  captionStyle?: string;
}

export type ProjectRow = {
  id: string;
  title: string;
  content: string;
  format: VideoFormat | string;
  length: VideoLength | string;
  style: VisualStyle | string;
  custom_style?: string | null;
  custom_style_image?: string | null;
  presenter_focus?: string | null;
  character_description?: string | null;
  character_images?: string[] | null;
  voice_type?: string | null;
  voice_id?: string | null;
  voice_name?: string | null;
  brand_mark?: string | null;
  character_consistency_enabled?: boolean | null;
  inspiration_style?: string | null;
  story_tone?: string | null;
  story_genre?: string | null;
  voice_inclination?: string | null;
  disable_expressions?: boolean | null;
  project_type?: ProductId | string | null;
};

/** Callback matching React.Dispatch<SetStateAction<GenerationState>> */
export type SetGenerationState = (updater: GenerationState | ((prev: GenerationState) => GenerationState)) => void;

/** Context passed to pipeline functions for state management and API calls */
export interface PipelineContext {
  setState: SetGenerationState;
  callPhase: (body: Record<string, unknown>, timeoutMs?: number, endpoint?: string) => Promise<Record<string, unknown>>;
  toast: (opts: { title?: string; description?: string; variant?: "default" | "destructive" }) => void;  // Legacy signature — adapter wraps Sonner
}

// ---- Constants ----

export const SCENE_COUNTS: Record<VideoLength, number> = { short: 15, brief: 28, presentation: 36 };
export const CINEMATIC_ENDPOINT = "generate-cinematic";
export const DEFAULT_ENDPOINT = "generate-video";

export const INITIAL_GENERATION_STATE: GenerationState = {
  step: "idle",
  progress: 0,
  sceneCount: 6,
  currentScene: 0,
  totalImages: 6,
  completedImages: 0,
  isGenerating: false,
  statusMessage: undefined,
};

// ---- Utilities ----

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RawScene {
  number?: number;
  voiceover?: string;
  narration?: string;
  visualPrompt?: string;
  visual_prompt?: string;
  duration?: number;
  imageUrl?: string;
  image_url?: string;
  imageUrls?: string[];
  audioUrl?: string;
  audio_url?: string;
  videoUrl?: string;
  video_url?: string;
  title?: string;
  subtitle?: string;
  subVisuals?: string[];
  [key: string]: unknown;
}

/** Normalize raw scene data from the database into typed Scene objects */
export const normalizeScenes = (raw: unknown): Scene[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((s: RawScene, idx: number) => ({
    number: s?.number ?? idx + 1,
    voiceover: s.voiceover ?? s.narration ?? "",
    visualPrompt: s.visualPrompt ?? s.visual_prompt ?? "",
    subVisuals: Array.isArray(s.subVisuals) ? s.subVisuals : undefined,
    duration: typeof s.duration === "number" ? s.duration : 8,
    imageUrl: s.imageUrl ?? s.image_url,
    imageUrls: Array.isArray(s.imageUrls) ? s.imageUrls : undefined,
    audioUrl: s.audioUrl ?? s.audio_url,
    videoUrl: s.videoUrl ?? s.video_url,
    title: s.title,
    subtitle: s.subtitle,
  }));
};

/** Extract metadata from the first scene's _meta field */
export const extractMeta = (scenes: Scene[]): {
  totalImages: number;
  completedImages: number;
  statusMessage?: string;
  costTracking?: CostTracking;
  phaseTimings?: PhaseTimings;
  totalTimeMs?: number;
} => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { totalImages: 0, completedImages: 0 };
  }
  const meta = scenes[0]?._meta;
  if (meta && typeof meta.totalImages === "number") {
    return {
      totalImages: meta.totalImages,
      completedImages: typeof meta.completedImages === "number" ? meta.completedImages : 0,
      statusMessage: meta.statusMessage,
      costTracking: meta.costTracking,
      phaseTimings: meta.phaseTimings,
      totalTimeMs: meta.totalTimeMs,
    };
  }
  return { totalImages: scenes.length, completedImages: 0 };
};

export const inferStepFromDb = (dbStatus: string | null | undefined, dbProgress: number): GenerationStep => {
  if (dbStatus === "complete") return "complete";
  if (dbStatus === "error") return "error";
  if (dbProgress < 10) return "analysis";
  if (dbProgress < 40) return "scripting";
  return "visuals";
};

export const inferCurrentSceneFromDb = (dbProgress: number, sceneCount: number): number => {
  if (sceneCount <= 0) return 0;
  if (dbProgress < 40) return 0;
  const p = Math.min(1, Math.max(0, (dbProgress - 40) / 50));
  return Math.max(1, Math.min(sceneCount, Math.round(p * sceneCount)));
};
