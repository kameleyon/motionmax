import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Language = "en" | "fr" | "ht" | "es";

interface LanguageSelectorProps {
  value: Language;
  onChange: (value: Language) => void;
}

const languages: { id: Language; label: string; flag: string }[] = [
  { id: "en", label: "English", flag: "\u{1F1FA}\u{1F1F8}" },
  { id: "fr", label: "Fran\u00e7ais", flag: "\u{1F1EB}\u{1F1F7}" },
  { id: "es", label: "Espa\u00f1ol", flag: "\u{1F1EA}\u{1F1F8}" },
  { id: "ht", label: "Krey\u00f2l Ayisyen", flag: "\u{1F1ED}\u{1F1F9}" },
];

export function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  const selected = languages.find((l) => l.id === value) || languages[0];

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
        <Globe className="h-3.5 w-3.5" />
        Language
      </h3>
      <Select value={value} onValueChange={(v) => onChange(v as Language)}>
        <SelectTrigger className="w-full sm:w-48">
          <SelectValue>
            <span className="flex items-center gap-2">
              <span>{selected.flag}</span>
              <span>{selected.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {languages.map((lang) => (
            <SelectItem key={lang.id} value={lang.id}>
              <span className="flex items-center gap-2">
                <span>{lang.flag}</span>
                <span>{lang.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
