import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Storytelling uses its own length type with user-friendly labels.
 * Backend mapping: short → "short", brief → "brief", extended → "presentation".
 * See StorytellingWorkspace.handleGenerate() for the mapping.
 */
export type StoryLength = "short" | "brief" | "extended";

interface StorytellingLengthSelectorProps {
  selected: StoryLength;
  onSelect: (length: StoryLength) => void;
}

const LENGTHS: { id: StoryLength; label: string; description: string }[] = [
  { id: "short", label: "Short", description: "< 3 min" },
  { id: "brief", label: "Brief", description: "< 7 min" },
  { id: "extended", label: "Extended", description: "< 15 min" },
];

export function StorytellingLengthSelector({ selected, onSelect }: StorytellingLengthSelectorProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Length
      </h3>
      <div className="flex flex-wrap gap-2">
        {LENGTHS.map((item) => {
          const isSelected = selected === item.id;
          return (
            <motion.button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                "rounded-xl border px-4 py-2.5 text-left transition-all",
                isSelected
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-transparent bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              <span className={cn(
                "text-sm font-medium block",
                isSelected ? "text-foreground" : "text-muted-foreground"
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
