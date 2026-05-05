import type { JSX } from 'react';

/**
 * Vertical bar chart. Flex row of full-width bars sized as `(v / max) * 100%`,
 * with an optional mono-9 label underneath each bar. Matches the design impl
 * in `tmp_design/motionmax/project/upgrades/admin-shared.jsx`.
 */

export type BarChartProps = {
  data: number[];
  h?: number;
  color?: string;
  labels?: string[];
};

export function BarChart({
  data,
  h = 180,
  color = 'var(--cyan)',
  labels,
}: BarChartProps): JSX.Element {
  const max = Math.max(...data, 0) || 1;

  return (
    <div
      style={{
        height: h,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 4,
        padding: '4px 0',
      }}
    >
      {data.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <div
            title={String(v)}
            style={{
              width: '100%',
              height: `${(v / max) * 100}%`,
              background: color,
              opacity: 0.85,
              borderRadius: '4px 4px 0 0',
              minHeight: 2,
              transition: 'height .3s',
            }}
          />
          {labels && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                color: 'var(--ink-mute)',
                letterSpacing: '.04em',
              }}
            >
              {labels[i]}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
