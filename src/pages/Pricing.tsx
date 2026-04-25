import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Check, X, Loader2 } from "lucide-react";
import AppShell from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { useSubscription } from "@/hooks/useSubscription";
import { useAuth } from "@/hooks/useAuth";
import { PLAN_PRICES } from "@/config/products";
import { STRIPE_PLANS } from "@/config/stripeProducts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** Pricing — mirrors the landing-page 3-up plan grid (Free / Creator
 *  / Studio) inside the dashboard chrome. Same visual language as
 *  Voice Lab / Projects: dark card, teal accents on the popular plan,
 *  serif headline, mono uppercase labels. CTAs hit real Stripe
 *  checkout via useSubscription.createCheckout. */

interface Plan {
  id: "free" | "creator" | "studio";
  name: string;
  price: string;
  blurb: string;
  features: { text: string; included: boolean }[];
  cta: string;
  popular?: boolean;
  accent: "neutral" | "teal" | "gold";
  /** Null for Free — clicking it routes to /auth or no-ops if already
   *  signed in. */
  priceId: string | null;
}

const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    blurb: "Perfect for trying out the platform.",
    features: [
      { text: "150 one-time credits", included: true },
      { text: "720p video export", included: true },
      { text: "Landscape format", included: true },
      { text: "3 Smart Flow videos", included: true },
      { text: "Voice cloning", included: false },
    ],
    cta: "Get started free",
    accent: "neutral",
    priceId: null,
  },
  {
    id: "creator",
    name: "Creator",
    price: PLAN_PRICES.creator.monthly,
    blurb: "For content creators and small teams.",
    features: [
      { text: "500 credits/month", included: true },
      { text: "1080p video export", included: true },
      { text: "Portrait & landscape", included: true },
      { text: "1 voice clone", included: true },
      { text: "20 Smart Flow videos", included: true },
    ],
    cta: "Start with Creator",
    popular: true,
    accent: "teal",
    priceId: STRIPE_PLANS.creator.monthly.priceId,
  },
  {
    id: "studio",
    name: "Studio",
    price: PLAN_PRICES.studio.monthly,
    blurb: "For professionals and agencies.",
    features: [
      { text: "2,500 credits/month", included: true },
      { text: "4K video export", included: true },
      { text: "5 voice clones", included: true },
      { text: "Brand kit", included: true },
      { text: "Priority rendering", included: true },
      { text: "Character consistency", included: true },
      { text: "Unlimited Smart Flow", included: true },
    ],
    cta: "Start with Studio",
    accent: "gold",
    priceId: STRIPE_PLANS.studio.monthly.priceId,
  },
];

export default function Pricing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { createCheckout } = useSubscription();
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);

  const handleCta = async (plan: Plan) => {
    if (!plan.priceId) {
      if (!user) navigate("/auth");
      else toast.info("You're already on the platform — start creating!");
      return;
    }
    if (!user) {
      navigate(`/auth?next=/pricing&plan=${plan.id}`);
      return;
    }
    setPendingPlan(plan.id);
    try {
      const url = await createCheckout(plan.priceId, "subscription");
      if (url) window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start checkout", { description: msg });
    } finally {
      setPendingPlan(null);
    }
  };

  return (
    <AppShell breadcrumb="Pricing">
      <Helmet><title>Pricing · MotionMax</title></Helmet>

      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-8 sm:py-12 max-w-[1100px] mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="text-center"
        >
          <h1 className="font-serif text-[32px] sm:text-[40px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">
            Simple, transparent pricing
          </h1>
          <p className="text-[14px] sm:text-[15px] text-[#8A9198] mt-3">
            Start free. Upgrade when you're ready. No hidden fees.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5 mt-10 sm:mt-12">
          {PLANS.map((plan, i) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              pending={pendingPlan === plan.id}
              onCta={() => handleCta(plan)}
              delay={i * 0.05}
            />
          ))}
        </div>

        <p className="text-center text-[12px] text-[#5A6268] mt-8">
          All plans include a 7-day money-back guarantee. Annual billing saves 20%.
        </p>
      </div>
    </AppShell>
  );
}

function PlanCard({
  plan, pending, onCta, delay,
}: {
  plan: Plan;
  pending: boolean;
  onCta: () => void;
  delay: number;
}) {
  // Per-accent border + glow tokens. Teal = popular Creator card,
  // gold = Studio, neutral = Free. Same hue family as the rest of
  // the app so the page reads native to the editor chrome.
  const accentBorder =
    plan.accent === "teal"
      ? "border-[#14C8CC]/40 shadow-[0_18px_50px_-22px_rgba(20,200,204,0.45)]"
      : plan.accent === "gold"
        ? "border-[#E4C875]/30"
        : "border-white/8";

  const ctaClass =
    plan.accent === "teal"
      ? "bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] text-[#0A0D0F] hover:brightness-110"
      : plan.accent === "gold"
        ? "bg-transparent border border-[#E4C875]/40 text-[#E4C875] hover:bg-[#E4C875]/10"
        : "bg-transparent border border-white/15 text-[#ECEAE4] hover:bg-white/5";

  const checkColor =
    plan.accent === "gold" ? "text-[#E4C875]" : "text-[#14C8CC]";

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay }}
      className={cn(
        "relative rounded-2xl bg-[#10151A] border p-6 sm:p-7 flex flex-col",
        accentBorder,
      )}
    >
      {plan.popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#14C8CC] text-[#0A0D0F] font-mono text-[10px] tracking-[0.12em] uppercase font-semibold">
          Most popular
        </div>
      )}

      <h3 className="font-serif text-[20px] font-medium text-[#ECEAE4]">{plan.name}</h3>

      <div className="mt-2 flex items-baseline gap-1">
        <span className="font-serif text-[36px] font-medium text-[#ECEAE4] leading-none">{plan.price}</span>
        <span className="text-[13px] text-[#8A9198]">/month</span>
      </div>

      <p className="text-[13px] text-[#8A9198] mt-2.5">{plan.blurb}</p>

      <ul className="mt-5 space-y-2 flex-1">
        {plan.features.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            {f.included ? (
              <Check className={cn("w-4 h-4 shrink-0 mt-[1px]", checkColor)} />
            ) : (
              <X className="w-4 h-4 shrink-0 mt-[1px] text-[#5A6268]" />
            )}
            <span className={f.included ? "text-[#ECEAE4]" : "text-[#5A6268]"}>{f.text}</span>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        onClick={onCta}
        disabled={pending}
        className={cn("w-full mt-6 h-10 rounded-full font-semibold text-[12.5px] disabled:opacity-50", ctaClass)}
      >
        {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> : null}
        {pending ? "Opening checkout…" : plan.cta}
      </Button>
    </motion.div>
  );
}
