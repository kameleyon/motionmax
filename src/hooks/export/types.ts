/**
 * Shared types for video export state.
 * The old WebCodecs-based client-side encoder (videoExportWorker.ts) has been removed.
 * Exports are now handled server-side via the Render.com worker.
 */

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

/**
 * Discriminated union on `status` for video export state.
 * Each variant carries only the fields relevant to that step.
 *
 * Optional `undefined` sentinels (videoUrl, error) are included on variants
 * that don't own them so consumers can safely read the property without
 * narrowing first (e.g. `exportState.videoUrl` returns `string | undefined`).
 */
export type ExportState =
  | { status: "idle"; progress: 0; videoUrl?: undefined; error?: undefined }
  | { status: "loading"; progress: number; warning?: string; videoUrl?: undefined; error?: undefined }
  | { status: "rendering"; progress: number; warning?: string; sceneProgress?: SceneProgressData | null; videoUrl?: undefined; error?: undefined }
  | { status: "encoding"; progress: number; warning?: string; videoUrl?: undefined; error?: undefined }
  | { status: "complete"; progress: 100; videoUrl: string; error?: undefined }
  | { status: "error"; progress: number; error: string; videoUrl?: undefined };

/** Helper union of all possible status string values. */
export type ExportStatus = ExportState["status"];
