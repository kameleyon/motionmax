/**
 * Color-grade presets for export.
 *
 * Each preset returns an FFmpeg `-vf` filter snippet (a single comma-joined
 * fragment with NO leading/trailing comma). The caller composes these
 * snippets into the wider video filter chain — see joinVf().
 *
 * Filters chosen so they survive a CRF re-encode without obvious banding
 * and stay within the [0, 255] range. We use `eq`, `colorbalance`, and
 * `curves` because they're available in every static FFmpeg build we ship.
 */

export type ColorGrade =
  | "Kodak 250D"
  | "Bleach Bypass"
  | "Teal & Orange"
  | "Warm Film"
  | "Cool Noir"
  | "Desaturated";

const PRESETS: Record<ColorGrade, string> = {
  // Warm midtones, slight green-shadow lift, gentle contrast — the
  // classic motion-picture daylight stock.
  "Kodak 250D":
    "eq=contrast=1.08:saturation=1.05:gamma=0.97," +
    "colorbalance=rs=0.04:gs=-0.02:bs=-0.04:rm=0.05:gm=0.02:bm=-0.03:rh=0.02:gh=0.0:bh=-0.02",

  // High contrast, crushed blacks, low saturation — the "skip-bleach"
  // look. Strong contrast bump, big saturation cut.
  "Bleach Bypass":
    "eq=contrast=1.35:saturation=0.55:brightness=-0.02:gamma=0.95",

  // Push shadows toward teal, midtones/highlights toward orange — the
  // canonical Hollywood blockbuster grade.
  "Teal & Orange":
    "colorbalance=rs=-0.10:gs=0.0:bs=0.18:rm=0.10:gm=0.0:bm=-0.10:rh=0.12:gh=0.04:bh=-0.10," +
    "eq=contrast=1.10:saturation=1.05",

  // Warm tone push, slight contrast boost, soft gamma — Super-8 / 70s
  // film feel.
  "Warm Film":
    "colorbalance=rs=0.10:gs=0.02:bs=-0.10:rm=0.07:gm=0.0:bm=-0.05," +
    "eq=contrast=1.06:saturation=1.10:gamma=1.02",

  // Cold blue cast, low saturation, deep shadows — moody noir.
  "Cool Noir":
    "colorbalance=rs=-0.08:gs=-0.04:bs=0.10:rm=-0.05:gm=0.0:bm=0.08:rh=-0.02:gh=0.0:bh=0.04," +
    "eq=contrast=1.15:saturation=0.70:brightness=-0.03",

  // Just pull saturation way down. Useful as a neutral "documentary" look.
  Desaturated: "eq=saturation=0.45:contrast=1.04",
};

/**
 * Resolve a grade name to its FFmpeg filter snippet.
 * Returns `null` for unknown names or when grade is null/empty — the
 * caller MUST then skip the grade injection entirely (do NOT pass an
 * empty string to ffmpeg, that's a parse error in some chains).
 */
export function resolveGradeFilter(grade: string | null | undefined): string | null {
  if (!grade) return null;
  const preset = PRESETS[grade as ColorGrade];
  return preset ?? null;
}

/**
 * Append `extra` to an existing -vf chain. Handles the empty-base case
 * (when the encoder has no other filter, the grade alone is the chain)
 * and avoids double commas. Caller passes the BASE filter chain (e.g.
 * scaleAndPad or Ken Burns vf) and the grade filter (or null).
 */
export function joinVf(base: string, extra: string | null): string {
  if (!extra) return base;
  if (!base) return extra;
  return `${base},${extra}`;
}

export const SUPPORTED_GRADES: ReadonlyArray<ColorGrade> = [
  "Kodak 250D",
  "Bleach Bypass",
  "Teal & Orange",
  "Warm Film",
  "Cool Noir",
  "Desaturated",
];
