/**
 * Shared types for video export state.
 * The old WebCodecs-based client-side encoder (videoExportWorker.ts) has been removed.
 * Exports are now handled server-side via the Render.com worker.
 */

export type ExportStatus = "idle" | "loading" | "rendering" | "encoding" | "complete" | "error";

export interface ExportState {
  status: ExportStatus;
  progress: number;
  error?: string;
  warning?: string;
  videoUrl?: string;
}
