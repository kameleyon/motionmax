import { VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";

interface InclinationSelectorProps {
  disabled: boolean;
  onDisabledChange: (disabled: boolean) => void;
}

export function InclinationSelector({ disabled, onDisabledChange }: InclinationSelectorProps) {
  return (
    <button
      onClick={() => onDisabledChange(!disabled)}
      className={cn(
        "flex items-center gap-3 w-full rounded-xl border px-4 py-2.5 text-left transition-all",
        disabled
          ? "border-primary/50 bg-primary/5 shadow-sm"
          : "border-transparent dark:border-white/10 bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15"
      )}
    >
      <div className={cn(
        "w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors shrink-0",
        disabled ? "border-primary" : "border-muted-foreground/40"
      )}>
        {disabled && <div className="w-2 h-2 rounded-full bg-primary" />}
      </div>
      <VolumeX className={cn(
        "h-4 w-4 shrink-0",
        disabled ? "text-primary" : "text-muted-foreground"
      )} />
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn(
          "text-sm font-medium",
          disabled ? "text-foreground" : "text-muted-foreground"
        )}>
          Disable voice expressions
        </span>
        <span className="text-xs text-muted-foreground/60">
          (no [chuckle], [sigh], etc.)
        </span>
      </div>
    </button>
  );
}
