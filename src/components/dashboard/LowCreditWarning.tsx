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
    <div className="flex items-center gap-3 rounded-xl border border-[#E4C875]/40 bg-[#E4C875]/10 px-4 py-3">
      <AlertTriangle className="h-4 w-4 text-[#E4C875] shrink-0" />
      <p className="text-sm text-[#E4C875] dark:text-[#E4C875] flex-1">
        {balance === 0
          ? "You have no credits remaining."
          : `Only ${balance} credit${balance === 1 ? "" : "s"} remaining.`}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="text-xs h-7 shrink-0 border-[#E4C875]/40 text-[#E4C875] dark:text-[#E4C875] hover:bg-[#E4C875]/10"
        onClick={() => navigate("/pricing")}
      >
        Add Credits
      </Button>
    </div>
  );
}
