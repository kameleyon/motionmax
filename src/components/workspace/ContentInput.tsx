import { Textarea } from "@/components/ui/textarea";

const MAX_CONTENT_LENGTH = 500000;

interface ContentInputProps {
  content: string;
  onContentChange: (content: string) => void;
}

export function ContentInput({ content, onContentChange }: ContentInputProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
        Your Source Content
      </h3>
      <Textarea
        placeholder="Please add all your sources and documentations.

Example: Paste your article, blog post, script, or any text content you want to transform into a video..."
        className="min-h-[120px] sm:min-h-[180px] resize-none rounded-xl border-border bg-muted/50 dark:bg-white/10 text-sm placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-primary/20"
        value={content}
        onChange={(e) => onContentChange(e.target.value.slice(0, MAX_CONTENT_LENGTH))}
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/60">
          Paste your content or describe what you want to create.
        </p>
        <span className={`text-xs ${content.length > MAX_CONTENT_LENGTH * 0.9 ? "text-destructive" : "text-muted-foreground/50"}`}>
          {content.length.toLocaleString()} / {(MAX_CONTENT_LENGTH).toLocaleString()}
        </span>
      </div>
    </div>
  );
}
