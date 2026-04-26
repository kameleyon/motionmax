/**
 * Deterministic radial gradient seed derived from a project id.
 * Used as a thumbnail fallback when no thumbnail_url exists.
 *
 * Extracted from Sidebar.tsx and ProjectsGallery.tsx, both of which
 * had the same implementation.
 */
export function generateProjectGradient(id: string | null | undefined): string {
  if (!id) return "#10151A";
  const hash = id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  return `radial-gradient(60% 70% at 50% 50%, hsl(${hue}, 40%, 30%), hsl(${hue}, 60%, 10%) 70%, #05030a)`;
}
