import { Globe } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type Language = "en" | "fr" | "ht";

interface LanguageSelectorProps {
  value: Language;
  onChange: (value: Language) => void;
}

const languages: { id: Language; label: string; native: string }[] = [
  { id: "en", label: "English", native: "English" },
  { id: "fr", label: "French", native: "Français" },
  { id: "ht", label: "Haitian Creole", native: "Kreyòl Ayisyen" },
];

export function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Language</h3>
      <div className="flex flex-wrap gap-2">
        {languages.map((lang) => {
          const isSelected = value === lang.id;
          return (
            <motion.button
              key={lang.id}
              onClick={() => onChange(lang.id)}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-4 py-2.5 transition-all",
                isSelected
                  ? "border-primary/50 bg-primary/5 shadow-sm"
                  : "border-transparent dark:border-white/10 bg-muted dark:bg-white/10 hover:bg-muted/80 dark:hover:bg-white/15 hover:border-border"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
            >
              <Globe className={cn("h-4 w-4", isSelected ? "text-primary" : "text-muted-foreground")} />
              <span className={cn(
                "text-sm font-medium",
                isSelected ? "text-foreground" : "text-muted-foreground"
              )}>{lang.native}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
