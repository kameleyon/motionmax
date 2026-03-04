import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type StoryGenre = 
  | "documentary"
  | "fiction"
  | "educational"
  | "marketing"
  | "personal-story"
  | "news-report";

interface GenreSelectorProps {
  selected: StoryGenre;
  onSelect: (genre: StoryGenre) => void;
}

const GENRES: { id: StoryGenre; label: string }[] = [
  { id: "documentary", label: "Documentary" },
  { id: "fiction", label: "Fiction" },
  { id: "educational", label: "Educational" },
  { id: "marketing", label: "Marketing" },
  { id: "personal-story", label: "Personal Story" },
  { id: "news-report", label: "News Report" },
];

export function GenreSelector({ selected, onSelect }: GenreSelectorProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Genre / Style
      </h3>
      <div className="flex flex-wrap gap-2">
        {GENRES.map((genre) => {
          const isSelected = selected === genre.id;
          return (
            <motion.button
              key={genre.id}
              onClick={() => onSelect(genre.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-all",
                isSelected
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-transparent bg-muted dark:bg-white/10 text-muted-foreground hover:bg-muted/80 dark:hover:bg-white/15"
              )}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {genre.label}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
