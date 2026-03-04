import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type StoryTone = 
  | "casual"
  | "professional"
  | "dramatic"
  | "humorous"
  | "inspirational"
  | "suspenseful"
  | "educational";

interface ToneSelectorProps {
  selected: StoryTone;
  onSelect: (tone: StoryTone) => void;
}

const TONES: { id: StoryTone; label: string }[] = [
  { id: "casual", label: "Casual" },
  { id: "professional", label: "Professional" },
  { id: "dramatic", label: "Dramatic" },
  { id: "humorous", label: "Humorous" },
  { id: "inspirational", label: "Inspirational" },
  { id: "suspenseful", label: "Suspenseful" },
  { id: "educational", label: "Educational" },
];

export function ToneSelector({ selected, onSelect }: ToneSelectorProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Tone
      </h3>
      <div className="flex flex-wrap gap-2">
        {TONES.map((tone) => {
          const isSelected = selected === tone.id;
          return (
            <motion.button
              key={tone.id}
              onClick={() => onSelect(tone.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                isSelected
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-transparent bg-muted dark:bg-white/10 text-muted-foreground hover:bg-muted/80 dark:hover:bg-white/15"
              )}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {tone.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
