/** Generic placeholder shown while a lazy intake step chunk downloads.
 *  Matches the form's section spacing so the layout doesn't jump when
 *  the real component swaps in. C-5-7 (Prism PERF-011). */
export default function StepLoadingSkeleton({ height = 120 }: { height?: number }) {
  return (
    <div
      className="rounded-xl border border-white/5 bg-[#10151A]/60 animate-pulse"
      style={{ height }}
      aria-hidden="true"
    />
  );
}
