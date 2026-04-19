import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Check, X, Crown, Gem, Flame } from "lucide-react";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { PLAN_PRICES, yearlyDiscountPercent } from "@/config/products";
import { Button } from "@/components/ui/button";
import { BillingToggle } from "@/components/pricing/BillingToggle";

// ─── Configurable urgency date ────────────────────────────────────────────────
// Update this when you want to reset the countdown. Keep ~30 days out.
const PRICE_INCREASE_DATE = new Date("2026-05-19T23:59:59Z");

// ─── Social proof counts ──────────────────────────────────────────────────────
// TODO: replace with a real figure fetched from your analytics/DB once available
const SOCIAL_PROOF_COUNT = "2,400+";

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Returns days remaining until PRICE_INCREASE_DATE (never negative). */
function useDaysRemaining(): number {
  const [days, setDays] = useState<number>(() => {
    const diff = PRICE_INCREASE_DATE.getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const diff = PRICE_INCREASE_DATE.getTime() - Date.now();
      setDays(Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24))));
    }, 60_000); // refresh every minute
    return () => clearInterval(timer);
  }, []);

  return days;
}

/** Returns true only after client hydration — prevents SSR mismatch. */
function useIsClient(): boolean {
  const [isClient, setIsClient] = useState(false);
  useEffect(() => { setIsClient(true); }, []);
  return isClient;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

interface LandingPricingProps {
  onCtaClick: (label: string) => void;
}

const pricingPlans = [
  {
    name: "Creator",
    icon: Crown,
    monthlyPrice: PLAN_PRICES.creator.monthly,
    yearlyPrice: PLAN_PRICES.creator.yearly,
    description: "For content creators and social media",
    features: [
      { text: `${PLAN_LIMITS.creator.creditsPerMonth} credits/month + ${PLAN_LIMITS.creator.dailyFreeCredits} daily bonus`, included: true },
      { text: "1 credit = 1 second (5x for cinematic)", included: true },
      { text: "All video types", included: true },
      { text: "1080p quality", included: true },
      { text: "All formats (16:9, 9:16)", included: true },
      { text: "All 23 visual styles + custom", included: true },
      { text: "All caption styles with ASR sync", included: true },
      { text: `${PLAN_LIMITS.creator.voiceClones} voice clone`, included: true },
      { text: "11 languages", included: true },
      { text: "Free re-edits", included: true },
      { text: "No watermark", included: true },
      { text: "Brand kit", included: false },
      { text: "Priority rendering", included: false },
    ],
    buttonText: "Start Creating",
    popular: true,
    socialProof: `Join ${SOCIAL_PROOF_COUNT} creators`,
  },
  {
    name: "Studio",
    icon: Gem,
    monthlyPrice: PLAN_PRICES.studio.monthly,
    yearlyPrice: PLAN_PRICES.studio.yearly,
    description: "For agencies and professional teams",
    features: [
      { text: `${PLAN_LIMITS.studio.creditsPerMonth} credits/month + ${PLAN_LIMITS.studio.dailyFreeCredits} daily bonus`, included: true },
      { text: "1 credit = 1 second (5x for cinematic)", included: true },
      { text: "All video types", included: true },
      { text: "4K quality", included: true },
      { text: "All formats", included: true },
      { text: "All styles + premium effects", included: true },
      { text: "All caption styles", included: true },
      { text: `${PLAN_LIMITS.studio.voiceClones} voice clones`, included: true },
      { text: "11 languages", included: true },
      { text: "Free re-edits", included: true },
      { text: "No watermark", included: true },
      { text: "Full brand kit", included: true },
      { text: "Priority rendering", included: true },
    ],
    buttonText: "Go Studio",
    popular: false,
    socialProof: `Trusted by ${SOCIAL_PROOF_COUNT} creators`,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function LandingPricing({ onCtaClick }: LandingPricingProps) {
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");
  const daysRemaining = useDaysRemaining();
  const isClient = useIsClient();

  return (
    <section id="pricing" className="py-16 sm:py-24 bg-white/[0.02]">
      <div className="mx-auto max-w-5xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <h2 className="type-h1 tracking-tight text-foreground">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Start with a free trial. Upgrade when you're ready.
          </p>

          {/* Billing toggle */}
          <BillingToggle
            value={billingInterval}
            onChange={setBillingInterval}
            discountPercent={yearlyDiscountPercent()}
            className="mt-6"
          />

          {/* Yearly urgency note — client-only to avoid SSR mismatch */}
          {isClient && billingInterval === "yearly" && daysRemaining > 0 && (
            <motion.p
              key="yearly-urgency"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="mt-3 text-xs font-medium text-amber-400"
            >
              ⏳ Yearly pricing locked for {daysRemaining} more day{daysRemaining !== 1 ? "s" : ""} — price increases{" "}
              {PRICE_INCREASE_DATE.toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            </motion.p>
          )}
        </motion.div>

        {/* Scarcity badge — client-only */}
        {isClient && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3 }}
            className="flex justify-center mb-6"
          >
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400">
              <Flame className="h-3 w-3 shrink-0" aria-hidden="true" />
              Creator plan: 47 people upgraded this week
            </span>
          </motion.div>
        )}

        {/* Free trial banner */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-8 p-4 rounded-xl border border-border/30 bg-muted/20"
        >
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Free trial:</span> 150 credits to try everything. No credit card required.
          </p>
        </motion.div>

        {/* Plans grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {pricingPlans.map((plan, idx) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: idx * 0.1 }}
              className={`relative rounded-2xl border p-6 sm:p-8 ${
                plan.popular
                  ? "border-primary/50 bg-primary/5"
                  : "border-border/40 bg-card/50"
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                  Most Popular
                </div>
              )}

              {!plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-400 text-xs font-medium">
                  Best Value
                </div>
              )}

              <div className="flex items-center gap-3 mb-4">
                <plan.icon className="h-5 w-5 text-primary" />
                <h3 className="type-h3">{plan.name}</h3>
              </div>

              <p className="text-sm text-muted-foreground mb-4">{plan.description}</p>

              <div className="mb-6">
                <span className="text-3xl font-bold text-foreground">
                  {billingInterval === "monthly" ? plan.monthlyPrice : plan.yearlyPrice}
                </span>
                <span className="text-sm text-muted-foreground">/month</span>
                {billingInterval === "yearly" && (
                  <span className="ml-2 text-xs text-muted-foreground">(billed annually)</span>
                )}
              </div>

              <Button
                className="w-full mb-3"
                variant={plan.popular ? "default" : "outline"}
                onClick={() => onCtaClick(plan.buttonText)}
              >
                {plan.buttonText}
              </Button>

              {/* Social proof micro-copy under CTA */}
              <p className="text-center text-xs text-muted-foreground mb-6">
                {plan.socialProof}
              </p>

              <ul className="space-y-2.5">
                {plan.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {f.included ? (
                      <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                    ) : (
                      <X className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />
                    )}
                    <span className={f.included ? "text-foreground" : "text-muted-foreground/50"}>
                      {f.text}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>

        {/* Credit packs note */}
        <p className="text-center text-xs text-muted-foreground mt-8">
          Need more? Top up anytime with credit packs starting at $9.99.
        </p>
      </div>
    </section>
  );
}
