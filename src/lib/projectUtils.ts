/**
 * Normalizes legacy "smart-flow" project type values to the canonical "smartflow"
 * identifier. New projects always use "smartflow"; this handles older DB records
 * created before the naming was standardized.
 */
export function normalizeProjectType(type: string | null | undefined): string {
  if (!type) return "doc2video";
  return type === "smart-flow" ? "smartflow" : type;
}

// ---------------------------------------------------------------------------
// PROJECT_TYPE_META — single source of truth for icon and label per project type
// ---------------------------------------------------------------------------

import { Video, Film, Wallpaper, type LucideIcon } from "lucide-react";

export interface ProjectTypeMeta {
  /** Canonical project type key */
  type: string;
  /** Human-readable label */
  label: string;
  /** URL segment / query-param mode used when navigating to the workspace */
  mode: string;
  /** Lucide icon component */
  Icon: LucideIcon;
}

export const PROJECT_TYPE_META: Record<string, ProjectTypeMeta> = {
  doc2video: { type: "doc2video", label: "Explainer",  mode: "doc2video", Icon: Video     },
  smartflow:  { type: "smartflow",  label: "Smart Flow", mode: "smartflow",  Icon: Wallpaper },
  cinematic:  { type: "cinematic",  label: "Cinematic",  mode: "cinematic",  Icon: Film      },
};

/** Returns the meta entry for a given (possibly legacy) project type. Falls back to doc2video. */
export function getProjectTypeMeta(type: string | null | undefined): ProjectTypeMeta {
  return PROJECT_TYPE_META[normalizeProjectType(type)] ?? PROJECT_TYPE_META.doc2video;
}
