import type { ReactNode } from 'react';

/** Pill-style on/off row with an optional expanded body. Matches the
 *  design-bundle FeatureToggle spec: icon tile on the left, title +
 *  subtitle + cost badge in the middle, switch on the right; expanded
 *  sub-controls rendered below when `on` is true. */
export default function FeatureToggle({
  icon, title, subtitle, cost, on, onToggle, children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  cost?: number;
  on: boolean;
  onToggle: (next: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className={
        'rounded-xl transition-colors ' +
        (on
          ? 'border border-[#14C8CC]/25 bg-gradient-to-br from-[#14C8CC]/[0.04] to-transparent'
          : 'border border-white/5 bg-[#151B20]')
      }
    >
      <div className="flex items-center gap-3 p-3.5 sm:p-[14px_16px]">
        <div
          className={
            'w-8 h-8 rounded-lg grid place-items-center border shrink-0 ' +
            (on
              ? 'bg-[#14C8CC]/10 text-[#14C8CC] border-[#14C8CC]/30'
              : 'bg-[#1B2228] text-[#8A9198] border-white/5')
          }
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[13.5px] sm:text-[14px] font-semibold text-[#ECEAE4]">{title}</div>
            {cost !== undefined && (
              <span className={`font-mono text-[9px] tracking-wider uppercase ${on ? 'text-[#14C8CC]' : 'text-[#5A6268]'}`}>
                +{cost} cr
              </span>
            )}
          </div>
          <div className="text-[11.5px] sm:text-[12px] text-[#8A9198] mt-0.5 leading-[1.4]">{subtitle}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onToggle(!on)}
          className={
            'relative w-9 h-5 rounded-full transition-colors shrink-0 border ' +
            (on ? 'bg-[#14C8CC] border-transparent' : 'bg-[#1B2228] border-white/10')
          }
        >
          <span
            className={
              'absolute top-[1px] w-4 h-4 rounded-full transition-all ' +
              (on ? 'left-[18px] bg-[#0A0D0F]' : 'left-[1px] bg-[#8A9198]')
            }
          />
        </button>
      </div>
      {on && children && (
        <div className="px-4 pb-4 pt-3 border-t border-dashed border-white/10">
          {children}
        </div>
      )}
    </div>
  );
}
