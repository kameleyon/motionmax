import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface LoadingSpinnerProps {
  /** Size variant — controls icon dimensions */
  size?: "sm" | "md" | "lg" | "xl";
  /** Additional className */
  className?: string;
  /** Optional label shown below the spinner */
  label?: string;
  /** Whether to center the spinner in its container */
  centered?: boolean;
}

const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
  xl: "h-12 w-12",
};

/**
 * Standardized loading spinner component.
 * Use this instead of inline Loader2 for consistent sizing across the app.
 */
export function LoadingSpinner({
  size = "lg",
  className,
  label,
  centered = true,
}: LoadingSpinnerProps) {
  const spinner = (
    <div className={cn(
      centered && "flex flex-col items-center justify-center gap-3",
      className,
    )}>
      <Loader2 className={cn(sizeClasses[size], "animate-spin text-primary")} />
      {label && (
        <p className="text-sm text-muted-foreground">{label}</p>
      )}
    </div>
  );

  return spinner;
}
