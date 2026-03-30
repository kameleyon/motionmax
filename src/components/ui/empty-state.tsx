import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  /** Icon to display above the title */
  icon: LucideIcon;
  /** Main heading text */
  title: string;
  /** Supporting description text */
  description?: string;
  /** Optional CTA button label */
  actionLabel?: string;
  /** Optional CTA click handler */
  onAction?: () => void;
  /** Additional className for the container */
  className?: string;
  /** Icon size variant */
  iconSize?: "sm" | "md" | "lg";
}

const iconSizes = {
  sm: "h-8 w-8",
  md: "h-12 w-12",
  lg: "h-16 w-16",
};

/**
 * Consistent empty state component for use across the app.
 * Displays an icon, title, optional description, and optional action button.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className,
  iconSize = "md",
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn(
        "flex flex-col items-center justify-center py-12 px-6 text-center",
        className,
      )}
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted/50 mb-4">
        <Icon className={cn(iconSizes[iconSize], "text-muted-foreground/60")} />
      </div>
      <h3 className="text-lg font-semibold text-foreground mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-muted-foreground max-w-sm mb-4">{description}</p>
      )}
      {actionLabel && onAction && (
        <Button onClick={onAction} size="sm">
          {actionLabel}
        </Button>
      )}
    </motion.div>
  );
}
