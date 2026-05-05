import * as React from "react";
import { Search } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { LucideIcon } from "lucide-react";

export interface AdminEmptyProps {
  /** Optional Lucide icon. Defaults to Search (the design's "no matches" icon). */
  icon?: LucideIcon;
  /** Primary line ("No matching users", "No activity in this window", etc.). */
  title: string;
  /** Secondary hint ("Try widening the date range.", etc.). */
  hint?: string;
  /** Optional CTA label/handler. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/**
 * Thin admin-namespace wrapper around the shared `EmptyState`. Keeps the
 * admin prop names (`title`, `hint`) so callers don't need to remember the
 * generic component's `description` field, and defaults the icon to a
 * magnifier for "no matching X" cases.
 */
export function AdminEmpty({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  className,
}: AdminEmptyProps) {
  return (
    <EmptyState
      icon={icon ?? Search}
      title={title}
      description={hint}
      actionLabel={actionLabel}
      onAction={onAction}
      className={className}
      iconSize="md"
    />
  );
}
