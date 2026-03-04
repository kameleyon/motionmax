import { Coins } from "lucide-react";
import { getCreditsRequired } from "@/lib/planLimits";
import { cn } from "@/lib/utils";

interface CreditEstimateProps {
  projectType: "doc2video" | "storytelling" | "smartflow" | "cinematic";
  length: string;
  creditsBalance: number;
}

export function CreditEstimate({ projectType, length, creditsBalance }: CreditEstimateProps) {
  const cost = getCreditsRequired(projectType, length);
  const hasEnough = creditsBalance >= cost;

  return (
    <div className={cn(
      "flex items-center justify-between rounded-xl border px-4 py-3 text-sm transition-colors",
      hasEnough
        ? "border-border/50 bg-card/50"
        : "border-destructive/30 bg-destructive/5"
    )}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Coins className="h-4 w-4" />
        <span>Estimated cost</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={cn(
          "font-semibold tabular-nums",
          hasEnough ? "text-foreground" : "text-destructive"
        )}>
          {cost} credit{cost !== 1 ? "s" : ""}
        </span>
        <span className="text-xs text-muted-foreground/70">
          ({creditsBalance} available)
        </span>
      </div>
    </div>
  );
}
