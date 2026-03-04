import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type VideoLength = "short" | "brief" | "presentation";

interface LengthSelectorProps {
  selected: VideoLength;
  onSelect: (length: VideoLength) => void;
}

const lengths: { id: VideoLength; label: string; duration: string }[] = [
  { id: "short", label: "Short", duration: "< 3 min" },
  { id: "brief", label: "Brief", duration: "< 5 min" },
  { id: "presentation", label: "Presentation", duration: "< 10 min" },
];

export function LengthSelector({ selected, onSelect }: LengthSelectorProps) {
  return (
    <div className="space-y-2 sm:space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Length</h3>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {lengths.map((length) => (
          <motion.button
            key={length.id}
            onClick={() => onSelect(length.id)}
            className={cn(
              "rounded-lg sm:rounded-xl border px-3 sm:px-4 py-2 sm:py-2.5 transition-all",
              selected === length.id
                ? "border-primary/50 bg-primary/5 shadow-sm"
                : "border-transparent dark:border-white/10 bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15 hover:border-border"
            )}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
          >
            <p className={cn(
              "text-xs sm:text-sm font-medium",
              selected === length.id ? "text-foreground" : "text-muted-foreground"
            )}>{length.label}</p>
            <p className="text-[10px] sm:text-xs text-muted-foreground/70">{length.duration}</p>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
