import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, Zap, Clock } from "lucide-react";
import { differenceInDays, parseISO } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSubscription, CREDIT_PACKS } from "@/hooks/useSubscription";
import { useToast } from "@/hooks/use-toast";

const DISMISS_KEY = "sub_alert_dismissed_until";
const DISMISS_HOURS = 24;
const EXPIRY_WARNING_DAYS = 7;
const LOW_CREDITS_THRESHOLD = 3;

function isDismissed(): boolean {
  try {
    const until = localStorage.getItem(DISMISS_KEY);
    if (!until) return false;
    return new Date(until) > new Date();
  } catch {
    return false;
  }
}

function setDismissed() {
  const until = new Date();
  until.setHours(until.getHours() + DISMISS_HOURS);
  localStorage.setItem(DISMISS_KEY, until.toISOString());
}

type AlertReason = "expiring" | "expired" | "low_credits" | null;

function getAlertReason(
  subscribed: boolean,
  plan: string,
  subscriptionEnd: string | null,
  creditsBalance: number,
): AlertReason {
  if (subscribed && subscriptionEnd) {
    const daysLeft = differenceInDays(parseISO(subscriptionEnd), new Date());
    if (daysLeft < 0) return "expired";
    if (daysLeft <= EXPIRY_WARNING_DAYS) return "expiring";
  }
  if (creditsBalance <= LOW_CREDITS_THRESHOLD && plan !== "free") {
    return "low_credits";
  }
  return null;
}

export function SubscriptionRenewalModal() {
  const { subscribed, plan, subscriptionEnd, creditsBalance, createCheckout } =
    useSubscription();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AlertReason>(null);
  const [topUpLoading, setTopUpLoading] = useState(false);

  useEffect(() => {
    if (isDismissed()) return;
    const r = getAlertReason(subscribed, plan, subscriptionEnd, creditsBalance);
    if (r) {
      setReason(r);
      setOpen(true);
    }
  }, [subscribed, plan, subscriptionEnd, creditsBalance]);

  const handleDismiss = () => {
    setDismissed();
    setOpen(false);
  };

  const handleRenew = () => {
    handleDismiss();
    navigate("/pricing");
  };

  const handleTopUp = async () => {
    setTopUpLoading(true);
    try {
      await createCheckout(CREDIT_PACKS[50].priceId, "payment");
      handleDismiss();
    } catch {
      toast({ variant: "destructive", title: "Checkout failed", description: "Please try again." });
    } finally {
      setTopUpLoading(false);
    }
  };

  const daysLeft = subscriptionEnd
    ? differenceInDays(parseISO(subscriptionEnd), new Date())
    : 0;

  const title =
    reason === "expired"
      ? "Subscription Expired"
      : reason === "expiring"
      ? `Subscription Expiring ${daysLeft === 0 ? "Today" : `in ${daysLeft} Day${daysLeft !== 1 ? "s" : ""}`}`
      : "Running Low on Credits";

  const description =
    reason === "expired"
      ? "Your subscription has expired. Renew now to continue creating videos."
      : reason === "expiring"
      ? "Renew your subscription before it expires to avoid service interruption."
      : `You have ${creditsBalance} credit${creditsBalance !== 1 ? "s" : ""} remaining. Top up to keep generating.`;

  if (!open || !reason) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleDismiss(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-5 w-5 text-orange-500" />
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-2">
          {(reason === "expired" || reason === "expiring") && (
            <Button onClick={handleRenew} className="w-full gap-2">
              <RefreshCw className="h-4 w-4" />
              Renew Subscription
            </Button>
          )}

          <Button
            variant={reason === "low_credits" ? "default" : "outline"}
            onClick={handleTopUp}
            disabled={topUpLoading}
            className="w-full gap-2"
          >
            <Zap className="h-4 w-4" />
            {topUpLoading ? "Opening checkout…" : "Buy 50 Credits — $14.99"}
          </Button>

          <Button
            variant="ghost"
            onClick={handleDismiss}
            className="w-full text-muted-foreground text-sm"
          >
            Remind me later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
