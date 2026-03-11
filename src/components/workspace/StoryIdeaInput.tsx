import { Textarea } from "@/components/ui/textarea";

const MAX_STORY_LENGTH = 500000;

interface StoryIdeaInputProps {
  value: string;
  onChange: (value: string) => void;
}

export function StoryIdeaInput({ value, onChange }: StoryIdeaInputProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Your Story Idea
      </h3>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_STORY_LENGTH))}
        placeholder="Describe your story idea, concept, or theme. What's the narrative you want to tell? What emotions do you want to evoke?

Example: A young entrepreneur's journey from a garage startup to building a billion-dollar company, facing setbacks, making hard decisions, and ultimately finding that success isn't just about money..."
        className="min-h-[180px] resize-none rounded-xl border-border bg-muted/50 dark:bg-white/10 text-sm placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-primary/20"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/60">
          Be descriptive. The more detail you provide, the richer your story will be.
        </p>
        <span className={`text-[10px] ${value.length > MAX_STORY_LENGTH * 0.9 ? "text-destructive" : "text-muted-foreground/50"}`}>
          {value.length.toLocaleString()} / {MAX_STORY_LENGTH.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
