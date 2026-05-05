import type { JSX } from 'react';

/**
 * Inline-SVG sparkline. Mirrors the design implementation in
 * `tmp_design/motionmax/project/upgrades/admin-shared.jsx` — point math
 * `(i/(n-1))*w, h - ((v-min)/range)*h` and an optional area fill at .12 opacity
 * underneath a 1.4px round-cap polyline.
 */

export type SparklineProps = {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
  fill?: boolean;
};

export function Sparkline({
  data,
  w = 90,
  h = 30,
  color = 'var(--cyan)',
  fill = true,
}: SparklineProps): JSX.Element | null {
  if (data.length === 0) {
    return null;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const denom = data.length === 1 ? 1 : data.length - 1;

  const pts = data
    .map((v, i) => `${(i / denom) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  const area = `0,${h} ${pts} ${w},${h}`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      {fill && <polyline points={area} fill={color} opacity={0.12} />}
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
