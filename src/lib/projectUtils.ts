/**
 * Normalizes legacy "smart-flow" project type values to the canonical "smartflow"
 * identifier. New projects always use "smartflow"; this handles older DB records
 * created before the naming was standardized.
 */
export function normalizeProjectType(type: string | null | undefined): string {
  if (!type) return "doc2video";
  return type === "smart-flow" ? "smartflow" : type;
}
