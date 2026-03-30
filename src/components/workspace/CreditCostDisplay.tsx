import { Coins, AlertTriangle } from "lucide-react";
import { getCreditsRequired } from "@/lib/planLimits";
import { motion } from "framer-motion";

interface CreditCostDisplayProps {
  projectType: "doc2video" | "storytelling" | "smartflow" | "cinematic";
  length: string;
  creditsBalance: number;
}

export function CreditCostDisplay({ projectType, length, creditsBalance }: CreditCostDisplayProps) {
  const creditsRequired = getCreditsRequired(projectType, length);
  const hasEnoughCredits = creditsBalance >= creditsRequired;
  const isLowBalance = creditsBalance < creditsRequired * 2 && creditsBalance >= creditsRequired;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      {/* Cost Breakdown */}
      <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-card border border-border">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Generation Cost</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {creditsBalance} available
          </span>
          <span className="text-base font-bold text-primary">
            {creditsRequired} {creditsRequired === 1 ? "credit" : "credits"}
          </span>
        </div>
      </div>

      {/* Low Balance Warning */}
      {isLowBalance && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-start gap-2 px-4 py-3 rounded-lg bg-[hsl(var(--warning))]/10 border border-[hsl(var(--warning))]/30"
        >
          <AlertTriangle className="h-4 w-4 text-[hsl(var(--warning))] mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground">Low credit balance</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              You have {creditsBalance} credits remaining. Consider adding more credits to avoid interruptions.
            </p>
          </div>
        </motion.div>
      )}

      {/* Insufficient Credits Warning */}
      {!hasEnoughCredits && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-start gap-2 px-4 py-3 rounded-lg bg-destructive/10 border border-destructive/30"
        >
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-xs font-medium text-foreground">Insufficient credits</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              You need {creditsRequired} credits but only have {creditsBalance}. Please add credits or upgrade your plan to continue.
            </p>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
