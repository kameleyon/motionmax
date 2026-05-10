import { useEffect, useState } from "react";
import { Loader2, Coins, Check } from "lucide-react";
import { motion } from "framer-motion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSubscription } from "@/hooks/useSubscription";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  TOP_UP_PACKS,
  formatUsd,
  type TopUpPack,
  type TopUpSku,
} from "@/config/pricing";
import {
  isLikelyEUUser,
  EU_COOLING_OFF_CONSENT_COPY,
} from "@/lib/euCoolingOff";
import { useNavigate } from "react-router-dom";

/**
 * TopUpPacksModal — one-time credit-pack purchase UI.
 *
 * Mounted from:
 *   • Settings → Credits ("Buy more credits" button)
 *   • RightRail credit-counter chip ("Top up →" link)
 *
 * Wires straight into the create-checkout edge fn with `kind: 'topup'`
 * so we route to the top-up SKU (one-time, mode=payment) without
 * touching the user's subscription. Top-up credits never expire per
 * ToS §6.
 *
 * EU/EEA/UK cooling-off waiver is preserved from B-V1-5: the checkbox
 * gates the CTA when the timezone heuristic flags the visitor.
 */
export interface TopUpPacksModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional pre-selection (e.g. from a "you're low on credits" CTA). */
  defaultSku?: TopUpSku;
}

export function TopUpPacksModal({
  open,
  onOpenChange,
  defaultSku = "plus",
}: TopUpPacksModalProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { createCheckout } = useSubscription();
  const [selected, setSelected] = useState<TopUpSku>(defaultSku);
  const [pending, setPending] = useState(false);
  const [isEU, setIsEU] = useState(false);
  const [euWaived, setEuWaived] = useState(false);

  useEffect(() => {
    if (open) setIsEU(isLikelyEUUser());
  }, [open]);

  // Reset selection if the modal is reopened with a different default.
  useEffect(() => {
    if (open) setSelected(defaultSku);
  }, [open, defaultSku]);

  const pack: TopUpPack | undefined = TOP_UP_PACKS.find((p) => p.sku === selected);

  const handleBuy = async () => {
    if (!pack) return;

    if (!user) {
      onOpenChange(false);
      navigate(`/auth?next=/pricing`);
      return;
    }
    if (isEU && !euWaived) {
      toast.error("Please confirm the EU/UK cooling-off waiver to continue.");
      return;
    }

    const priceId = pack.getPriceId();
    if (!priceId) {
      // Sync script hasn't been run yet — surface a clear operator
      // message rather than letting Stripe error opaquely.
      toast.error("Top-up pack not configured", {
        description:
          "Run scripts/sync-stripe-products.mjs and add the printed STRIPE_PRICE_TOPUP_* env vars.",
      });
      return;
    }

    setPending(true);
    try {
      const url = await createCheckout(priceId, "payment", {
        euCoolingOffWaived: isEU ? euWaived : false,
      });
      if (url) window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start checkout", { description: msg });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-[#10151A] border-white/10">
        <DialogHeader>
          <DialogTitle className="font-serif text-[22px] text-[#ECEAE4] flex items-center gap-2">
            <Coins className="w-5 h-5 text-[#E4C875]" />
            Buy more credits
          </DialogTitle>
          <DialogDescription className="text-[13px] text-[#8A9198]">
            One-time top-up packs. Available on every plan, including Free.
            Top-up credits never expire.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
          {TOP_UP_PACKS.map((p) => {
            const isSelected = selected === p.sku;
            return (
              <motion.button
                key={p.sku}
                type="button"
                onClick={() => setSelected(p.sku)}
                whileTap={{ scale: 0.98 }}
                className={cn(
                  "rounded-xl bg-[#0A0D0F] border p-4 text-left transition-colors relative",
                  isSelected
                    ? "border-[#14C8CC]/60 shadow-[0_0_0_1px_rgba(20,200,204,0.4)]"
                    : "border-white/8 hover:border-white/20",
                )}
                aria-pressed={isSelected}
              >
                {isSelected && (
                  <span className="absolute top-2.5 right-2.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#14C8CC] text-[#0A0D0F]">
                    <Check className="w-3 h-3" />
                  </span>
                )}
                <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268]">
                  {p.label}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="font-serif text-[24px] text-[#ECEAE4] leading-none">
                    {p.credits.toLocaleString()}
                  </span>
                  <span className="text-[11px] text-[#8A9198]">credits</span>
                </div>
                <div className="font-serif text-[16px] text-[#ECEAE4] mt-3">
                  {formatUsd(p.price_usd)}
                </div>
                <div className="font-mono text-[10px] text-[#5A6268] mt-1 tracking-wide">
                  ${p.per_credit.toFixed(3)} / credit
                </div>
              </motion.button>
            );
          })}
        </div>

        {/* EU cooling-off waiver — preserves B-V1-5 binding capture. */}
        {isEU && (
          <div
            className="mt-4 rounded-xl border border-[#E4C875]/30 bg-[#0A0D0F] p-3.5"
            data-testid="topup-eu-cooling-off-block"
          >
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={euWaived}
                onChange={(e) => setEuWaived(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#14C8CC]"
              />
              <span className="text-[12px] leading-[1.55] text-[#ECEAE4]">
                {EU_COOLING_OFF_CONSENT_COPY}
              </span>
            </label>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 mt-5">
          <p className="text-[11px] text-[#5A6268]">
            Secure checkout via Stripe. Credits added instantly on payment.
          </p>
          <Button
            onClick={handleBuy}
            disabled={pending || !pack || (isEU && !euWaived)}
            className="bg-[#14C8CC] text-[#0A0D0F] hover:brightness-110 h-10 px-5 rounded-full font-semibold"
          >
            {pending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Opening checkout…
              </>
            ) : pack ? (
              <>Buy {pack.credits.toLocaleString()} for {formatUsd(pack.price_usd)}</>
            ) : (
              <>Pick a pack</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
