import { Lightbulb } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface PresenterFocusInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function PresenterFocusInput({ value, onChange }: PresenterFocusInputProps) {
  return (
    <div className="space-y-3">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        What should the presenter focus on?
      </label>
      <Textarea
        placeholder="e.g., Make the content fast-paced and engaging, focus on key statistics, use a conversational tone, emphasize the call-to-action..."
        className="min-h-[80px] resize-none rounded-xl border-border/50 bg-transparent text-sm placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 2000))}
        maxLength={2000}
      />
      <div className="text-right text-[10px] text-muted-foreground/50">
        {value.length}/2000
      </div>
      <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
        <Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Guide the AI on tone, pacing, emphasis, or specific points to highlight in the narration.
        </span>
      </div>
    </div>
  );
}
