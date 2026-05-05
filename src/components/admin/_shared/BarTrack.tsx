import * as React from "react";

export interface BarTrackProps {
  /** Percent fill, 0..100. Values outside the range are clamped. */
  pct: number;
  /** Optional CSS color/background for the fill (overrides default cyan gradient). */
  color?: string;
  /** Optional pixel height. Default 6 to match the design. */
  height?: number;
  className?: string;
  /** Optional accessible label (mapped to aria-label on the track). */
  ariaLabel?: string;
}

/**
 * Inline progress bar matching `.bar-track > .bar-fill` from the design.
 *
 * Track: 6px tall (override via `height`), panel-3 background, line border,
 * border-radius 4. Fill: linear cyan gradient (override via `color`),
 * width = pct%. Width transitions over .3s.
 */
export function BarTrack({
  pct,
  color,
  height = 6,
  className,
  ariaLabel,
}: BarTrackProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const trackCls = ["bar-track", className ?? ""].filter(Boolean).join(" ");
  const fillStyle: React.CSSProperties = {
    width: `${clamped}%`,
    ...(color ? { background: color } : {}),
  };
  return (
    <div
      className={trackCls}
      style={{ height }}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="bar-fill" style={fillStyle} />
    </div>
  );
}
