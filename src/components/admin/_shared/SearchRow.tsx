import * as React from "react";
import { I } from "./AdminIcons";

export interface SearchRowProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Override the leading icon. Defaults to the magnifier from `I.search`. */
  icon?: React.ReactNode;
  /** Container min-width in px (e.g. 220 for the design's typical search row). */
  minWidth?: number;
  className?: string;
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * `.search-row` shell: panel-3 background, line border, mono baseline
 * with a leading magnifier icon and a transparent sans-13 input.
 */
export function SearchRow({
  value,
  onChange,
  placeholder,
  icon,
  minWidth,
  className,
  ariaLabel,
  onKeyDown,
}: SearchRowProps) {
  const cls = ["search-row", className ?? ""].filter(Boolean).join(" ");
  const style: React.CSSProperties = minWidth ? { minWidth } : {};
  const SearchIcon = I.search;
  return (
    <div className={cls} style={style}>
      {icon ?? <SearchIcon />}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? "Search"}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
