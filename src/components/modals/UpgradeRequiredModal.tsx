import { useEffect, useState } from "react";
import { createScopedLogger } from "@/lib/logger";
import { AlertCircle, CreditCard, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSubscription, CREDIT_PACKS } from "@/hooks/useSubscription";
import { toast } from "sonner";
import { isLikelyEUUser } from "@/lib/euCoolingOff";

const log = createScopedLogger("UpgradeModal");

interface UpgradeRequiredModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: string;
  showCreditsOption?: boolean;
}

export function UpgradeRequiredModal({
  open,
  onOpenChange,
  reason,
  showCreditsOption = true,
}: UpgradeRequiredModalProps) {
  const navigate = useNavigate();
  const { createCheckout, plan } = useSubscription();

  // B-V1-5 / Comply L-B-05 — EU/EEA/UK users cannot complete a quick credit
  // top-up from this modal because there's no room here for the cooling-off
  // waiver checkbox. We route them to /pricing where the binding consent UI
  // lives instead.
  const [isEU, setIsEU] = useState(false);
  useEffect(() => {
    setIsEU(isLikelyEUUser());
  }, []);

  const handleUpgrade = () => {
    onOpenChange(false);
    navigate("/pricing");
  };

  const handleBuyCredits = async () => {
    if (isEU) {
      onOpenChange(false);
      navigate("/pricing");
      toast.info(
        "Tick the EU/UK cooling-off waiver on the pricing page to continue.",
      );
      return;
    }
    try {
      await createCheckout(CREDIT_PACKS[300].priceId, "payment");
    } catch (error) {
      log.error("Failed to create checkout:", error);
      toast.error("Failed to open checkout. Please try again.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <AlertCircle className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle className="text-lg">Upgrade Required</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2">
            {reason}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-4">
          <Button onClick={handleUpgrade} className="w-full gap-2">
            <Zap className="h-4 w-4" />
            View Plans & Upgrade
          </Button>

          {showCreditsOption && plan !== "free" && (
            <Button 
              variant="outline" 
              onClick={handleBuyCredits} 
              className="w-full gap-2"
            >
              <CreditCard className="h-4 w-4" />
              Buy More Credits
            </Button>
          )}

          <Button 
            variant="ghost" 
            onClick={() => onOpenChange(false)}
            className="w-full"
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
