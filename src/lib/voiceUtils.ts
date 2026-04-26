/**
 * Shared voice-related utilities. Extracted from per-component
 * duplicate definitions in:
 *   src/components/dashboard/Sidebar.tsx
 *   src/components/dashboard/Hero.tsx
 *   src/components/dashboard/RightRail.tsx
 *   src/components/dashboard/ProjectsGallery.tsx
 *   src/components/intake/IntakeRail.tsx
 *   src/components/editor/Inspector.tsx
 *
 * Use these instead of redefining locally.
 */

/** Strip provider prefixes ("sm:", "sm2:", "gm:") from a voice id and
 *  capitalise the result. Returns an em dash for missing/empty input. */
export function prettyVoiceName(raw: string | null | undefined): string {
  if (!raw) return "—";
  const stripped = raw.replace(/^(sm2?|gm):/i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Same logic as `prettyVoiceName` but accepts a fallback display
 *  string used when one is provided by a speakers catalog (e.g. the
 *  designer-friendly label on `SpeakerSelector.speakers[i].label`).
 *  Mirrors the in-component variant in Hero.tsx. */
export function prettyVoiceLabel(id: string, fallback: string): string {
  const stripped = id.replace(/^(sm2?|gm):/i, "");
  return fallback || (stripped.charAt(0).toUpperCase() + stripped.slice(1));
}
