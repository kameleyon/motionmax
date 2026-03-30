/**
 * Shared types for video export state.
 * The old WebCodecs-based client-side encoder (videoExportWorker.ts) has been removed.
 * Exports are now handled server-side via the Render.com worker.
 */

export type ExportStatus = "idle" | "loading" | "rendering" | "encoding" | "complete" | "error";

export interface SceneProgressEntry {
  sceneIndex: number;
  phase: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  message?: string;
}

export interface SceneProgressData {
  totalScenes: number;
  completedScenes: number;
  currentSceneIndex: number;
  overallPhase: string;
  overallMessage: string;
  scenes: SceneProgressEntry[];
  updatedAt: string;
  etaSeconds: number;
}

export interface ExportState {
  status: ExportStatus;
  progress: number;
  error?: string;
  warning?: string;
  videoUrl?: string;
  /** Per-scene progress data from the worker (available during rendering) */
  sceneProgress?: SceneProgressData | null;
}
