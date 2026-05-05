import * as React from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Admin-shell toggle matching the design's `.tgl` pattern.
 *
 * Renders a hidden checkbox plus a visible 34x18 track and 13x13 knob.
 * When checked, the track adopts the cyan-dim color (or warn-tinted in
 * danger mode) and the knob translates 15px and turns cyan/warn.
 *
 * Conforms to the CSS in `MotionMax Admin.html` (`.tgl`, `.tgl .track`,
 * `.tgl input:checked + .track`, `.tgl.danger ...`).
 */
export function Toggle({
  checked,
  onChange,
  danger,
  ariaLabel,
  disabled,
  className,
}: ToggleProps) {
  const cls = ["tgl", danger ? "danger" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <label className={cls} aria-label={ariaLabel}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" aria-hidden="true" />
    </label>
  );
}
