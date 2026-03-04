import { AlertTriangle, CreditCard, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSubscription, CREDIT_PACKS } from "@/hooks/useSubscription";

interface SubscriptionSuspendedModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: "past_due" | "unpaid" | "canceled";
}

export function SubscriptionSuspendedModal({
  open,
  onOpenChange,
  status,
}: SubscriptionSuspendedModalProps) {
  const { openCustomerPortal, createCheckout } = useSubscription();

  const handleUpdatePayment = async () => {
    try {
      await openCustomerPortal();
    } catch (error) {
      console.error("Failed to open portal:", error);
    }
  };

  const handleBuyCredits = async () => {
    try {
      await createCheckout(CREDIT_PACKS[50].priceId, "payment");
    } catch (error) {
      console.error("Failed to create checkout:", error);
    }
  };

  const getTitle = () => {
    switch (status) {
      case "past_due":
        return "Payment Overdue";
      case "unpaid":
        return "Payment Required";
      case "canceled":
        return "Subscription Canceled";
      default:
        return "Subscription Issue";
    }
  };

  const getDescription = () => {
    switch (status) {
      case "past_due":
        return "Your subscription payment is overdue. Please update your payment method to continue creating new content. You can still access your existing projects.";
      case "unpaid":
        return "Your subscription payment failed. Please update your payment method to restore full access. You can still view your existing projects.";
      case "canceled":
        return "Your subscription has been canceled. To create new content, please resubscribe or purchase credits.";
      default:
        return "There's an issue with your subscription. Please update your payment method.";
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <DialogTitle className="text-lg">{getTitle()}</DialogTitle>
          </div>
          <DialogDescription className="text-left pt-2">
            {getDescription()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-4">
          {status !== "canceled" && (
            <Button onClick={handleUpdatePayment} className="w-full gap-2">
              <ExternalLink className="h-4 w-4" />
              Update Payment Method
            </Button>
          )}

          <Button 
            variant={status === "canceled" ? "default" : "outline"} 
            onClick={handleBuyCredits} 
            className="w-full gap-2"
          >
            <CreditCard className="h-4 w-4" />
            Buy Credits Instead
          </Button>

          <Button 
            variant="ghost" 
            onClick={() => onOpenChange(false)}
            className="w-full"
          >
            I'll Do This Later
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-2">
          You can still access and view your existing projects.
        </p>
      </DialogContent>
    </Dialog>
  );
}
