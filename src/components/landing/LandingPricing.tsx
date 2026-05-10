import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Check, X, Crown, Gem, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useExperiment } from "@/hooks/useExperiment";
import { EXPERIMENTS } from "@/lib/experiments";
import {
  isLikelyEUUser,
  EU_COOLING_OFF_CONSENT_COPY,
} from "@/lib/euCoolingOff";
import {
  PLANS,
  isPromoActive,
  PROMO_BANNER_COPY,
  formatUsd,
  monthlyPromoPercentOff,
  yearlySavingsPercent,
} from "@/config/pricing";
import { cn } from "@/lib/utils";

interface LandingPricingProps {
  onCtaClick: (label: string) => void;
}

type CycleKey = "monthly" | "yearly";

/**
 * LandingPricing — marketing-facing 3-up plan grid.
 *
 * B-NEW-21 (2026-05-10): Mirrors the dashboard /pricing page (single
 * source of truth in src/config/pricing.ts) so prices, multi-pack
 * ladder counts, promo windows, and EU cooling-off advisory all stay
 * lock-step. CTA routes to /auth — the actual checkout call (and the
 * binding cooling-off waiver capture) lives at /pricing.
 */
export default function LandingPricing({ onCtaClick }: LandingPricingProps) {
  const [billingInterval, setBillingInterval] = useState<CycleKey>("yearly");
  const promoActive = isPromoActive();

  // A/B: keep ROI-focused headline experiment from the prior version.
  const pricingHeadlineVariant = useExperiment(EXPERIMENTS.landing_pricing_headline);

  // EU cooling-off advisory only — binding capture happens at /pricing.
  const [isEU, setIsEU] = useState(false);
  useEffect(() => {
    setIsEU(isLikelyEUUser());
  }, []);

  return (
    <section id="pricing" className="py-16 sm:py-24 bg-white/[0.02]">
      <div className="mx-auto max-w-5xl px-6 sm:px-8">
        {/* Promo banner — surfaces the "first 3 months" offer. */}
        {promoActive && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="mx-auto max-w-[680px] mb-8 rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-500/10 to-primary/10 px-4 py-3 flex items-center gap-3"
            data-testid="landing-promo-banner"
          >
            <Sparkles className="h-4 w-4 text-amber-400 shrink-0" />
            <p className="text-sm text-foreground leading-snug">
              {PROMO_BANNER_COPY}
            </p>
          </motion.div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <h2 className="type-h1 tracking-tight text-foreground">
            {pricingHeadlineVariant === "roi_headline"
              ? "Stop paying $500/video. Make them yourself."
              : "Simple, transparent pricing"}
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            {pricingHeadlineVariant === "roi_headline"
              ? "One subscription. Unlimited AI videos. Cancel anytime."
              : "Start free. Upgrade when you're ready."}
          </p>

          {/* Billing toggle — yearly default to anchor on the bigger discount. */}
          <div className="inline-flex items-center gap-1 mt-6 rounded-full bg-muted/50 p-1 border border-border/30">
            <CycleBtn active={billingInterval === "monthly"} onClick={() => setBillingInterval("monthly")}>
              Monthly
            </CycleBtn>
            <CycleBtn active={billingInterval === "yearly"} onClick={() => setBillingInterval("yearly")}>
              Yearly
              <span className="ml-1.5 text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">
                Save {yearlySavingsPercent("creator")}%
              </span>
            </CycleBtn>
          </div>
        </motion.div>

        {/* Free trial advisory */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-8 p-4 rounded-xl border border-border/30 bg-muted/20"
        >
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Free plan:</span>{" "}
            {PLANS.free.credits_monthly} credits/month + {PLANS.free.daily_credits} daily refresh credits.
            No credit card required.
          </p>
        </motion.div>

        {/* Plans grid — Creator + Studio (Free is highlighted in the strip above). */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <LandingPlanCard
            planId="creator"
            cycle={billingInterval}
            promoActive={promoActive}
            popular
            icon={Crown}
            onCta={() => onCtaClick("Start with Creator")}
            extras={["1080p quality", "All formats (16:9, 9:16)", "11 languages"]}
          />
          <LandingPlanCard
            planId="studio"
            cycle={billingInterval}
            promoActive={promoActive}
            icon={Gem}
            onCta={() => onCtaClick("Go Studio")}
            extras={["4K quality", "Brand kit", "Character consistency"]}
          />
        </div>

        {/* Refund guarantee */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          7-day money-back guarantee on first subscription payment. No questions asked.
        </p>

        {/* EU cooling-off advisory (binding checkbox lives at /pricing) */}
        {isEU && (
          <div
            className="mt-6 mx-auto max-w-[640px] rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-muted-foreground"
            data-testid="eu-cooling-off-advisory"
          >
            <p className="font-medium text-foreground mb-1">
              EU / UK customers — important notice
            </p>
            <p className="leading-relaxed">
              {EU_COOLING_OFF_CONSENT_COPY} You will be asked to confirm this
              at checkout.
            </p>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground mt-3">
          Need more? Top up anytime with credit packs starting at {formatUsd(14.99)}.
        </p>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────

function CycleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "px-4 py-1.5 rounded-full text-sm font-medium transition-colors inline-flex items-center",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LandingPlanCard({
  planId,
  cycle,
  promoActive,
  popular = false,
  icon: Icon,
  onCta,
  extras,
}: {
  planId: "creator" | "studio";
  cycle: CycleKey;
  promoActive: boolean;
  popular?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  onCta: () => void;
  /** Marketing-only feature bullets layered on top of the entitlement set. */
  extras: string[];
}) {
  const plan = PLANS[planId];
  const promoPct = monthlyPromoPercentOff(planId);
  const showStrike = cycle === "monthly" && promoActive && promoPct > 0;

  const priceMain =
    cycle === "monthly"
      ? formatUsd(promoActive ? plan.price_monthly_first3 : plan.price_monthly_after)
      : formatUsd(plan.price_yearly_monthly);
  const priceStrike =
    cycle === "monthly" && promoActive ? formatUsd(plan.price_monthly_after) : null;
  const billedAs =
    cycle === "yearly"
      ? `${formatUsd(plan.price_yearly_total)} billed annually`
      : promoActive
        ? "for the first 3 months"
        : "billed monthly";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className={cn(
        "relative rounded-2xl border p-6 sm:p-8",
        popular ? "border-primary/50 bg-primary/5" : "border-border/40 bg-card/50",
      )}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-primary text-primary-foreground text-xs font-medium">
          Most Popular
        </div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <Icon className="h-5 w-5 text-primary" />
        <h3 className="type-h3">{plan.name}</h3>
      </div>

      <p className="text-sm text-muted-foreground mb-4">{plan.blurb}</p>

      <div className="mb-2 flex items-baseline gap-1.5 flex-wrap">
        {priceStrike && (
          <span className="text-lg text-muted-foreground line-through">
            {priceStrike}
          </span>
        )}
        <span className="text-3xl font-bold text-foreground">{priceMain}</span>
        <span className="text-sm text-muted-foreground">/month</span>
      </div>
      <p className="text-xs text-muted-foreground mb-4">{billedAs}</p>

      {showStrike && (
        <p className="text-xs text-amber-400 mb-4">
          Save {promoPct}% for 3 months — then {formatUsd(plan.price_monthly_after)}/mo.
        </p>
      )}

      <Button
        className="w-full mb-3"
        variant={popular ? "default" : "outline"}
        onClick={onCta}
      >
        Start with {plan.name}
      </Button>

      <p className="text-center text-xs text-muted-foreground/60 mb-6">
        7-day money-back guarantee
      </p>

      <ul className="space-y-2.5">
        <Bullet on>
          {(cycle === "monthly" ? plan.credits_monthly : plan.credits_yearly).toLocaleString()} credits/{cycle === "monthly" ? "month" : "year"}
        </Bullet>
        <Bullet on>+{plan.daily_credits} daily refresh credits</Bullet>
        <Bullet on>
          {plan.voice_clones} voice clone slot{plan.voice_clones === 1 ? "" : "s"}
        </Bullet>
        <Bullet on>
          {plan.automation_slots} automation slot{plan.automation_slots === 1 ? "" : "s"}
        </Bullet>
        <Bullet on={plan.watermark_removal}>Watermark removal</Bullet>
        <Bullet on={plan.priority_queue}>Priority queue</Bullet>
        {extras.map((e) => (
          <Bullet key={e} on>{e}</Bullet>
        ))}
      </ul>
    </motion.div>
  );
}

function Bullet({ children, on = true }: { children: React.ReactNode; on?: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {on ? (
        <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
      ) : (
        <X className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" />
      )}
      <span className={on ? "text-foreground" : "text-muted-foreground/50"}>
        {children}
      </span>
    </li>
  );
}
