import type { JSX, ReactNode } from 'react';

/**
 * Status pill. Maps `variant` directly onto the design CSS class names
 * (`.pill[.cyan|.purple|.gold|.ok|.warn|.err|.danger]`) and toggles the
 * `.dot` modifier that draws the leading 5px circle via the `::before`
 * pseudo-element. `default` stays plain `.pill`.
 */

export type PillVariant =
  | 'cyan'
  | 'purple'
  | 'gold'
  | 'ok'
  | 'warn'
  | 'err'
  | 'danger'
  | 'default';

export type PillProps = {
  variant?: PillVariant;
  dot?: boolean;
  children: ReactNode;
};

export function Pill({
  variant = 'default',
  dot = false,
  children,
}: PillProps): JSX.Element {
  const className = ['pill', variant === 'default' ? '' : variant, dot ? 'dot' : '']
    .filter(Boolean)
    .join(' ');

  return <span className={className}>{children}</span>;
}
