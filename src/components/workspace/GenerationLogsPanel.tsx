import { Button } from "@/components/ui/button";
import { Terminal, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";

interface GenerationLogsPanelProps {
  logs: any[];
  show: boolean;
  onToggle: () => void;
  isGenerating?: boolean;
}

export function GenerationLogsPanel({ logs, show, onToggle, isGenerating }: GenerationLogsPanelProps) {
  if (logs.length === 0 && !isGenerating) return null;

  return (
    <div className="mt-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <Terminal className="h-3.5 w-3.5" />
        {show ? "Hide" : "Show"} Generation Logs ({logs.length})
        {show ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </Button>
      {show && (
        <ScrollArea className="mt-2 h-48 rounded-lg border border-border/50 bg-background/80 p-3">
          <div className="font-mono text-xs space-y-1">
            {logs.length === 0 && (
              <p className="text-muted-foreground/60 italic">Waiting for logs...</p>
            )}
            {logs.map((log) => (
              <div key={log.id} className={cn(
                "flex gap-2",
                log.category === "system_error" ? "text-destructive" :
                log.category === "system_warning" ? "text-yellow-500" :
                "text-muted-foreground"
              )}>
                <span className="shrink-0 text-muted-foreground/50">
                  {format(new Date(log.created_at), "HH:mm:ss")}
                </span>
                <span className="break-all">{log.message}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
