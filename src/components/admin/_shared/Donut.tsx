import type { JSX } from 'react';

/**
 * CSS conic-gradient donut. Slices are rendered as continuous arcs around the
 * disc; the inner hole sits at `inset: size * 0.18` over `--panel-2`, with a
 * serif total + mono caption centered in the well. Mirrors the design in
 * `tmp_design/motionmax/project/upgrades/admin-shared.jsx`.
 *
 * `short(n)` is inlined locally so this primitive has no cross-folder
 * dependencies — the `format.ts` helpers (Phase 0.3) will replace it later.
 */

export type DonutSlice = {
  value: number;
  color: string;
  label?: string;
};

export type DonutProps = {
  slices: DonutSlice[];
  size?: number;
};

function shortNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function Donut({ slices, size = 160 }: DonutProps): JSX.Element {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const safeTotal = total === 0 ? 1 : total;

  let acc = 0;
  const stops = slices
    .map((s) => {
      const start = (acc / safeTotal) * 360;
      acc += s.value;
      const end = (acc / safeTotal) * 360;
      return `${s.color} ${start}deg ${end}deg`;
    })
    .join(', ');

  const innerInset = size * 0.18;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: total === 0 ? 'var(--panel-3)' : `conic-gradient(${stops})`,
        position: 'relative',
        flexShrink: 0,
      }}
      role="img"
      aria-label={`Donut chart, total ${total}`}
    >
      <div
        style={{
          position: 'absolute',
          inset: innerInset,
          borderRadius: '50%',
          background: 'var(--panel-2)',
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 24,
              fontWeight: 500,
              color: 'var(--ink)',
              letterSpacing: '-.01em',
            }}
          >
            {shortNumber(total)}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              color: 'var(--ink-mute)',
              letterSpacing: '.14em',
              textTransform: 'uppercase',
            }}
          >
            total
          </div>
        </div>
      </div>
    </div>
  );
}
