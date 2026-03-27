import { Lock } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Storytelling uses its own length type with user-friendly labels.
 * Backend mapping: short → "short", brief → "brief", extended → "presentation".
 * See StorytellingWorkspace.handleGenerate() for the mapping.
 */
export type StoryLength = "short" | "brief" | "extended";

interface StorytellingLengthSelectorProps {
  selected: StoryLength;
  onSelect: (length: StoryLength) => void;
  disabledLengths?: StoryLength[];
}

const LENGTHS: { id: StoryLength; label: string; description: string }[] = [
  { id: "short", label: "Short", description: "~3 min" },
  { id: "brief", label: "Brief", description: "~7 min" },
  { id: "extended", label: "Extended", description: "~9 min" },
];

export function StorytellingLengthSelector({ selected, onSelect, disabledLengths = [] }: StorytellingLengthSelectorProps) {
  const handleClick = (id: StoryLength, isDisabled: boolean) => {
    if (isDisabled) {
      const requiredPlan = id === "extended" ? "Creator" : "Starter";
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
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Length
      </h3>
      <div className="flex flex-wrap gap-2">
        {LENGTHS.map((item) => {
          const isSelected = selected === item.id;
          const isDisabled = disabledLengths.includes(item.id);
          return (
            <motion.button
              key={item.id}
              onClick={() => handleClick(item.id, isDisabled)}
              className={cn(
                "relative rounded-xl border px-4 py-2.5 text-left transition-all",
                isDisabled
                  ? "cursor-pointer opacity-60 border-transparent bg-muted/20 dark:bg-white/5"
                  : isSelected
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-transparent bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              {isDisabled && (
                <span className="absolute -top-2 right-1 flex items-center gap-0.5 rounded-full bg-muted-foreground/20 px-1.5 py-0.5 text-[8px] font-medium text-muted-foreground">
                  <Lock className="h-2.5 w-2.5" />
                  Pro
                </span>
              )}
              <span className={cn(
                "text-sm font-medium block",
                isDisabled
                  ? "text-muted-foreground/50"
                  : isSelected ? "text-foreground" : "text-muted-foreground"
              )}>
                {item.label}
              </span>
              <span className="text-xs text-muted-foreground/70">{item.description}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
