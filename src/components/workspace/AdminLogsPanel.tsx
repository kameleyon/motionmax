import { Button } from "@/components/ui/button";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface AdminLogsPanelProps {
  logs: any[];
  show: boolean;
  onToggle: () => void;
}

export function AdminLogsPanel({ logs, show, onToggle }: AdminLogsPanelProps) {
  if (logs.length === 0) return null;

  return (
    <div className="mt-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="gap-2 text-xs text-muted-foreground"
      >
        <Terminal className="h-3.5 w-3.5" />
        {show ? "Hide" : "Show"} Generation Logs ({logs.length})
      </Button>
      {show && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border/50 bg-background/80 p-3 font-mono text-xs space-y-1">
          {logs.map((log) => (
            <div key={log.id} className={cn(
              "flex gap-2",
              log.category === "system_error" ? "text-destructive" :
              log.category === "system_warning" ? "text-yellow-500" :
              "text-muted-foreground"
            )}>
              <span className="shrink-0 text-muted-foreground/60">
                {format(new Date(log.created_at), "HH:mm:ss")}
              </span>
              <span>{log.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
