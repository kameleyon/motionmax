import { useEffect, useRef, useState } from "react";

export interface PackOption {
  credits: number;
  multiplier: 1 | 2 | 4 | 10;
  /** Right-side hint, e.g. "+$14.50/mo" or "included". */
  priceHint: string;
}

/** Pack-multiplier dropdown ported from the design HTML.
 *  Selection writes into Stripe via the update-pack-quantity edge fn
 *  (caller wires the onChange handler — this component is purely UI).
 *
 *  `disabled` no longer prevents opening the menu — it just disables
 *  the row click handler. This lets users browse alternate pack tiers
 *  on plans they're not currently subscribed to (the parent toasts
 *  "Switch to this plan first" when they try to pick one). */
export function PackSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: PackOption[];
  value: number; // selected multiplier
  onChange: (mult: PackOption["multiplier"]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = options.find((o) => o.multiplier === value) ?? options[0];

  return (
    <div className={"pack-select" + (open ? " open" : "")} ref={ref}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          <b style={{ color: "var(--ink)", fontWeight: 500 }}>{current.credits.toLocaleString()}</b>
          {" "}credits <span className="muted">({current.multiplier} pack{current.multiplier === 1 ? "" : "s"})</span>
        </span>
        <span className="muted tiny">{current.priceHint}</span>
        <svg className="car" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div className="menu">
        {options.map((opt) => (
          <div
            key={opt.multiplier}
            className={"opt" + (opt.multiplier === value ? " on" : "")}
            onClick={() => { onChange(opt.multiplier); setOpen(false); }}
          >
            <span>
              {opt.credits.toLocaleString()} credits <span className="muted">({opt.multiplier} pack{opt.multiplier === 1 ? "" : "s"})</span>
            </span>
            <span className="pri">{opt.priceHint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
