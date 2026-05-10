/**
 * Shared TypeScript types for the generate-video Edge Function pipeline.
 *
 * Pure type module — no runtime code. Imported by index.ts and other lib/*
 * modules to keep the request/response/scene shape in lockstep.
 *
 * Extracted 2026-05-10 per audit C-4-2 (Arch C-A3). Zero behavior change.
 */

export interface GenerationRequest {
  // For starting new generation
  content?: string;
  format?: string;
  length?: string;
  style?: string;
  customStyle?: string;
  brandMark?: string;
  presenterFocus?: string;
  characterDescription?: string;
  disableExpressions?: boolean;
  characterConsistencyEnabled?: boolean; // Enable character reference generation (Pro only)
  // Voice selection
  voiceType?: "standard" | "custom";
  voiceId?: string;
  voiceName?: string;
  // Storytelling-specific fields
  projectType?: "doc2video" | "smartflow";
  inspirationStyle?: string;
  storyTone?: string;
  storyGenre?: string;
  voiceInclination?: string;
  brandName?: string;
  skipAudio?: boolean; // For Smart Flow without voice
  // For chunked phases
  phase?: "script" | "audio" | "images" | "finalize" | "regenerate-audio" | "regenerate-image";
  generationId?: string;
  projectId?: string;
  // For regeneration
  sceneIndex?: number;
  imageIndex?: number;
  newVoiceover?: string;
  imageModification?: string;
}

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
  title?: string;
  subtitle?: string;
  coverTitle?: string; // Catchy social media-style title for the first image (cover)
  _meta?: {
    statusMessage?: string;
    totalImages?: number;
    completedImages?: number;
    sceneIndex?: number;
    costTracking?: CostTracking;
    phaseTimings?: Record<string, number>;
    totalTimeMs?: number;
    lastUpdate?: string;
    characterBible?: Record<string, string>; // Character descriptions for visual consistency
  };
}

export interface ScriptResponse {
  title: string;
  scenes: Scene[];
  characters?: Record<string, string>; // Character bible for visual consistency
}

export interface CostTracking {
  scriptTokens: number;
  audioSeconds: number;
  imagesGenerated: number;
  estimatedCostUsd: number;
  // Track actual providers used for accurate logging
  audioProvider?: string;
  audioModel?: string;
  imageProvider?: string;
  imageModel?: string;
}
