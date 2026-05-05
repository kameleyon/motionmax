import type { JSX, ReactNode } from 'react';
import { I } from './AdminIcons';
import { Sparkline } from './Sparkline';

/**
 * Admin KPI tile. Renders the `.kpi[.cyan|.danger]` design with a label row
 * (mono uppercase + optional right-side icon), a serif headline value with an
 * optional unit, an optional delta line whose arrow + tone are derived from
 * `deltaDir`, and an optional corner sparkline.
 *
 * Tone classes (`cyan`, `danger`) carry the gradient + border tint from the
 * design CSS; the component leaves all visual styling to the global admin CSS
 * so it can be themed in one place.
 */

export type KpiDeltaDirection = 'up' | 'down' | 'neutral';
export type KpiTone = 'cyan' | 'danger';

export type KpiProps = {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string;
  deltaDir?: KpiDeltaDirection;
  spark?: number[];
  sparkColor?: string;
  icon?: ReactNode;
  tone?: KpiTone;
};

function deltaArrow(dir: KpiDeltaDirection | undefined): JSX.Element | null {
  if (dir === 'up') return <I.arrowUp />;
  if (dir === 'down') return <I.arrowDown />;
  return null;
}

export function Kpi({
  label,
  value,
  unit,
  delta,
  deltaDir,
  spark,
  sparkColor = 'var(--cyan)',
  icon,
  tone,
}: KpiProps): JSX.Element {
  const className = ['kpi', tone].filter(Boolean).join(' ');
  const deltaClass = ['delta', deltaDir ?? 'neutral'].join(' ');

  return (
    <div className={className}>
      <div className="lbl">
        <span>{label}</span>
        {icon}
      </div>
      <div className="v">
        {value}
        {unit !== undefined && <span className="unit">{unit}</span>}
      </div>
      {delta !== undefined && (
        <div className={deltaClass}>
          {deltaArrow(deltaDir)}
          {delta}
        </div>
      )}
      {spark && spark.length > 0 && (
        <div className="spark">
          <Sparkline data={spark} color={sparkColor} />
        </div>
      )}
    </div>
  );
}
