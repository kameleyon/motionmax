/**
 * Shared domain types used across the application.
 * Single source of truth for literal unions — UI selectors re-export from here.
 */

export type VideoFormat = "landscape" | "portrait" | "square";

export type VideoLength = "short" | "brief" | "presentation";

export type ProductId = "doc2video" | "storytelling" | "smartflow" | "cinematic";

export type VisualStyle =
  | "minimalist" | "doodle" | "stick" | "anime" | "realistic"
  | "3d-pixar" | "claymation" | "sketch" | "caricature" | "storybook"
  | "crayon" | "moody" | "chalkboard" | "lego" | "cardboard" | "babie" | "custom";

export type Language = "en" | "fr" | "es" | "ht" | "pt" | "de" | "it" | "ru" | "zh" | "ja" | "ko";

export interface SystemLogEntry {
  id: string;
  created_at: string;
  message: string;
  category?: string;
  event_type?: string;
  [key: string]: unknown;
}

export function toVideoFormat(s: string | null | undefined): VideoFormat {
  if (s === "landscape" || s === "portrait" || s === "square") return s;
  return "portrait";
}

export function toVideoLength(s: string | null | undefined): VideoLength {
  if (s === "short" || s === "brief" || s === "presentation") return s;
  return "short";
}
