import { Users } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface CharacterDescriptionInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function CharacterDescriptionInput({ value, onChange }: CharacterDescriptionInputProps) {
  return (
    <div className="space-y-3">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Character Appearance
      </label>
      <Textarea
        placeholder="e.g., Main character is a Black woman with natural hair in her 30s, diverse multicultural cast, Asian male protagonist..."
        className="min-h-[80px] resize-none rounded-xl border-border/50 bg-transparent text-sm placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
        <Users className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Describe the ethnicity, appearance, and diversity of characters to appear in visuals.
        </span>
      </div>
    </div>
  );
}
