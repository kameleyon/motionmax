import * as React from "react";

export interface SectionHeaderProps {
  title: string;
  /** Right-side slot for filters, buttons, pills, etc. */
  right?: React.ReactNode;
  className?: string;
  /** Heading level override; defaults to h2 to match the design. */
  as?: "h1" | "h2" | "h3";
}

/**
 * `.adm-sec-h` section header: serif-22 / weight-400 title on the left,
 * an optional right-aligned action slot. Used between admin tab subsections.
 */
export function SectionHeader({
  title,
  right,
  className,
  as = "h2",
}: SectionHeaderProps) {
  const cls = ["adm-sec-h", className ?? ""].filter(Boolean).join(" ");
  const Heading = as;
  return (
    <div className={cls}>
      <Heading>{title}</Heading>
      {right ? <div className="right">{right}</div> : null}
    </div>
  );
}
