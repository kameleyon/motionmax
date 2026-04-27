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
 *  capitalise the result. Returns an em dash for missing/empty input.
 *
 *  Special-case for `clone:<uuid>`: never expose the raw uuid in the UI.
 *  Callers that have access to the user's clone library (Inspector,
 *  Hero, RightRail) should resolve the friendly name FIRST via
 *  `resolveCloneName(raw, userClones)`. This function is the fallback
 *  for callsites that don't have clone-name context (e.g. server-side
 *  data shipped without a join). It returns "Cloned voice" instead of
 *  the broken "Clone:a10d3253..." that previously leaked through. */
export function prettyVoiceName(raw: string | null | undefined): string {
  if (!raw) return "—";
  if (raw.toLowerCase().startsWith("clone:")) return "Cloned voice";
  const stripped = raw.replace(/^(sm2?|gm):/i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Same logic as `prettyVoiceName` but accepts a fallback display
 *  string used when one is provided by a speakers catalog (e.g. the
 *  designer-friendly label on `SpeakerSelector.speakers[i].label`).
 *  Mirrors the in-component variant in Hero.tsx. */
export function prettyVoiceLabel(id: string, fallback: string): string {
  if (id.toLowerCase().startsWith("clone:")) return fallback || "Cloned voice";
  const stripped = id.replace(/^(sm2?|gm):/i, "");
  return fallback || (stripped.charAt(0).toUpperCase() + stripped.slice(1));
}

/** Resolve a `clone:<external_id>` picker value to its friendly name
 *  using the supplied clone library. Falls back to `prettyVoiceName`
 *  for any non-clone or unrecognized input.
 *
 *  Use this anywhere the user's `voice_name` (or picker value) might
 *  be a clone reference and you have access to `useUserClones`. */
export function resolveCloneName(
  raw: string | null | undefined,
  clones: Array<{ pickerId: string; externalId: string; name: string }>,
): string {
  if (!raw) return "—";
  const lower = raw.toLowerCase();
  if (lower.startsWith("clone:")) {
    const externalId = raw.slice("clone:".length);
    const match = clones.find((c) => c.externalId === externalId || c.pickerId === raw);
    if (match) return match.name;
    return "Cloned voice";
  }
  return prettyVoiceName(raw);
}
