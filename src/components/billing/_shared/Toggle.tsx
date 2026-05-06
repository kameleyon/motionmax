/** On/off toggle styled to match the design's `.tg` class. */
export function Toggle({ on, onChange, ariaLabel }: { on: boolean; onChange: (next: boolean) => void; ariaLabel?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={"tg" + (on ? " on" : "")}
      onClick={() => onChange(!on)}
    />
  );
}
