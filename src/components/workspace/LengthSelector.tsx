import { Lock } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type { VideoLength } from "@/types/domain";
import type { VideoLength } from "@/types/domain";

interface LengthSelectorProps {
  selected: VideoLength;
  onSelect: (length: VideoLength) => void;
  disabledLengths?: VideoLength[];
}

const lengths: { id: VideoLength; label: string; duration: string }[] = [
  { id: "short", label: "Short", duration: "~3 min" },
  { id: "brief", label: "Brief", duration: "~7 min" },
  { id: "presentation", label: "Presentation", duration: "~9 min" },
];

export function LengthSelector({ selected, onSelect, disabledLengths = [] }: LengthSelectorProps) {
  const handleClick = (id: VideoLength, isDisabled: boolean) => {
    if (isDisabled) {
      const requiredPlan = id === "presentation" ? "Creator" : "Starter";
      toast("Upgrade Required", {
        description: `${id.charAt(0).toUpperCase() + id.slice(1)} length requires ${requiredPlan} plan or higher.`,
        action: {
          label: "View Plans",
          onClick: () => window.location.href = "/pricing",
        },
      });
      return;
    }
    onSelect(id);
  };

  return (
    <div className="space-y-2 sm:space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Length</h3>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {lengths.map((length) => {
          const isDisabled = disabledLengths.includes(length.id);
          return (
            <motion.button
              key={length.id}
              onClick={() => handleClick(length.id, isDisabled)}
              className={cn(
                "relative rounded-lg sm:rounded-xl border px-3 sm:px-4 py-2 sm:py-2.5 transition-all",
                isDisabled
                  ? "cursor-pointer opacity-60 border-transparent dark:border-white/10 bg-muted/20 dark:bg-white/5"
                  : selected === length.id
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-transparent dark:border-white/10 bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15 hover:border-border"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              {isDisabled && (
                <span className="absolute -top-2 right-1 flex items-center gap-0.5 rounded-full bg-muted-foreground/20 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" />
                  Pro
                </span>
              )}
              <p className={cn(
                "text-xs sm:text-sm font-medium",
                isDisabled
                  ? "text-muted-foreground/50"
                  : selected === length.id ? "text-foreground" : "text-muted-foreground"
              )}>{length.label}</p>
              <p className="text-xs sm:text-xs text-muted-foreground/70">{length.duration}</p>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
