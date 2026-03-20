import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LowCreditWarningProps {
  balance: number;
  threshold?: number;
}

export function LowCreditWarning({ balance, threshold = 5 }: LowCreditWarningProps) {
  const navigate = useNavigate();

  if (balance >= threshold) return null;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
      <p className="text-sm text-amber-700 dark:text-amber-400 flex-1">
        {balance === 0
          ? "You have no credits remaining."
          : `Only ${balance} credit${balance === 1 ? "" : "s"} remaining.`}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="text-xs h-7 shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
        onClick={() => navigate("/pricing")}
      >
        Add Credits
      </Button>
    </div>
  );
}
