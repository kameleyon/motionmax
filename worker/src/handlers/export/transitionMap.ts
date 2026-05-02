/**
 * Map intake/editor transition names to FFmpeg `xfade` parameters.
 *
 * The intake form exposes 5 user-facing names; the editor exposes 4
 * (no "Default", since the editor always operates on a chosen scene).
 * Both feed into the same xfade engine — `concatWithCrossfade` accepts
 * `{ duration, transition }` where `transition` is the xfade type and
 * a `duration` of 0 means "do a hard concat instead of an xfade pair".
 */

import type { TransitionType } from "./transitions.js";

export type IntakeTransition = "Default" | "Cut" | "Dissolve" | "Whip" | "Black";

export interface ResolvedTransition {
  /** FFmpeg xfade type. Ignored when duration is 0. */
  type: TransitionType;
  /** Crossfade duration in seconds. 0 = hard cut, no xfade pass. */
  duration: number;
}

/** Map a user-chosen transition name to its xfade params. */
export function resolveTransition(name: string | null | undefined): ResolvedTransition {
  switch (name) {
    case "Cut":
      // Hard concat — no crossfade pass. This is what the export
      // pipeline did for *every* project before this was wired up.
      return { type: "fade", duration: 0 };

    case "Dissolve":
      // Cross-dissolve — soft mix, ~0.6s, classic film cut.
      return { type: "dissolve", duration: 0.6 };

    case "Whip":
      // Quick directional swipe — short duration so it actually feels
      // like a whip rather than a slide.
      return { type: "slideleft", duration: 0.3 };

    case "Black":
      // Fade through black between scenes — high-contrast separator.
      return { type: "fadeblack", duration: 0.5 };

    case "Default":
    default:
      // Default is a gentle fade. Matches the legacy export-pipeline
      // default and is the safest choice when the user didn't pick.
      return { type: "fade", duration: 0.5 };
  }
}
