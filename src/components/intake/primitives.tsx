import type { ReactNode } from 'react';

/** Small uppercase-mono section label. All intake sections use it so the
 *  visual rhythm matches the design bundle.
 *
 *  Renders as a real <label> when `htmlFor` is provided so the visible
 *  label binds to the input as the accessible name (WCAG 2.1 AA: form
 *  fields must have programmatic labels, not visually-adjacent <div>s).
 *  Pass `htmlFor` and the matching `id` on the form control. */
export function IntakeLabel({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) {
  const className =
    'font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] mb-2 flex items-center gap-1.5';
  if (htmlFor) {
    return (
      <label htmlFor={htmlFor} className={className}>
        {children}
      </label>
    );
  }
  return <div className={className}>{children}</div>;
}

/** Card-style field wrapper. */
export function IntakeField({
  children, className = '',
}: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-[#151B20] border border-white/5 rounded-xl p-3 sm:p-4 ${className}`}>
      {children}
    </div>
  );
}

/** Toggleable pill button — used for music genre, camera motion, color
 *  grade choices. Cyan when on, mute grey when off. */
export function Pill({
  on, onClick, children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-mono text-[10.5px] tracking-[0.08em] uppercase transition-colors ' +
        (on
          ? 'border border-[#14C8CC]/40 bg-[#14C8CC]/10 text-[#14C8CC]'
          : 'border border-white/5 bg-[#151B20] text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/10')
      }
    >
      {children}
    </button>
  );
}

/** Horizontal range slider with a live label on the right. Keeps its
 *  accent on the cyan so it blends with the rest of the controls. */
export function IntakeSlider({
  value, onChange, min = 0, max = 100, fmt, label,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  fmt?: (v: number) => string;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range" min={min} max={max} value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="flex-1 accent-[#14C8CC]"
      />
      <div className="font-mono text-[10.5px] text-[#8A9198] tracking-[0.06em] min-w-[56px] text-right">
        {fmt ? fmt(value) : value}{label || ''}
      </div>
    </div>
  );
}
