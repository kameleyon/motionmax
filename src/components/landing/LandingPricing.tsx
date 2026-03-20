import { useState } from "react";
import { motion } from "framer-motion";
import { Check, X, Sparkles, Zap, Crown, Building2 } from "lucide-react";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { PLAN_PRICES, yearlyDiscountPercent } from "@/config/products";
import { Button } from "@/components/ui/button";

/* ──────────────────────────────────────────────
 * Pricing grid with monthly/yearly toggle.
 * Extracted from Landing.tsx to stay under 300 LOC.
 * ────────────────────────────────────────────── */

interface LandingPricingProps {
  onCtaClick: (label: string) => void;
}

const pricingPlans = [
  {
    name: "Free",
    icon: Sparkles,
    monthlyPrice: PLAN_PRICES.free.monthly,
    yearlyPrice: PLAN_PRICES.free.yearly,
    description: "Get started with basic features",
    features: [
      { text: `${PLAN_LIMITS.free.creditsPerMonth} credits/month`, included: true },
      { text: "Short videos only (<2 min)", included: true },
      { text: "720p quality", included: true },
      { text: "5 basic visual styles", included: true },
      { text: PLAN_LIMITS.free.allowedFormats.length === 1
          ? `${PLAN_LIMITS.free.allowedFormats[0].charAt(0).toUpperCase() + PLAN_LIMITS.free.allowedFormats[0].slice(1)} format only`
          : PLAN_LIMITS.free.allowedFormats.map(f => f.charAt(0).toUpperCase() + f.slice(1)).join(", ").replace(/, ([^,]*)$/, " and $1") + " formats",
        included: true },
      { text: "Watermark on exports", included: false },
      { text: "Voice cloning", included: !PLAN_LIMITS.free.allowVoiceCloning },
      { text: "Infographics", included: PLAN_LIMITS.free.infographicsPerMonth > 0 },
    ],
    buttonText: "Get Started",
    buttonVariant: "outline" as const,
    popular: false,
  },
  {
    name: "Starter",
    icon: Zap,
    monthlyPrice: PLAN_PRICES.starter.monthly,
    yearlyPrice: PLAN_PRICES.starter.yearly,
    description: "Hobbyists & social creators",
    features: [
      { text: `${PLAN_LIMITS.starter.creditsPerMonth} credits/month`, included: true },
      { text: `${PLAN_LIMITS.starter.allowedLengths.map(l => l.charAt(0).toUpperCase() + l.slice(1)).join(" + ")} videos`, included: true },
      { text: "1080p quality", included: true },
      { text: "10 visual styles", included: true },
      { text: "All formats (16:9, 9:16, 1:1)", included: true },
      { text: "Standard narration voices", included: true },
      { text: "No watermark", included: true },
      { text: "Email support (48h)", included: true },
    ],
    buttonText: "Upgrade to Starter",
    buttonVariant: "outline" as const,
    popular: false,
  },
  {
    name: "Creator",
    icon: Crown,
    monthlyPrice: PLAN_PRICES.creator.monthly,
    yearlyPrice: PLAN_PRICES.creator.yearly,
    description: "Content creators & small biz",
    features: [
      { text: `${PLAN_LIMITS.creator.creditsPerMonth} credits/month`, included: true },
      { text: "All video lengths", included: true },
      { text: "1080p quality", included: true },
      { text: `All 13 styles${PLAN_LIMITS.creator.allowCustomStyle ? " + Custom" : ""}`, included: true },
      { text: "Full narration + voice effects", included: true },
      { text: `${PLAN_LIMITS.creator.voiceClones} voice clone`, included: PLAN_LIMITS.creator.allowVoiceCloning },
      { text: `${PLAN_LIMITS.creator.infographicsPerMonth} infographics/month`, included: PLAN_LIMITS.creator.infographicsPerMonth > 0 },
      { text: "Priority support (24h)", included: true },
    ],
    buttonText: "Upgrade to Creator",
    buttonVariant: "default" as const,
    popular: true,
  },
  {
    name: "Professional",
    icon: Building2,
    monthlyPrice: PLAN_PRICES.professional.monthly,
    yearlyPrice: PLAN_PRICES.professional.yearly,
    description: "Agencies & marketing teams",
    features: [
      { text: `${PLAN_LIMITS.professional.creditsPerMonth} credits/month`, included: true },
      { text: "4K quality", included: true },
      { text: "All styles + premium effects", included: true },
      { text: "Full narration + multilingual", included: true },
      { text: `${PLAN_LIMITS.professional.voiceClones} voice clones`, included: PLAN_LIMITS.professional.allowVoiceCloning },
      { text: "Unlimited infographics", included: PLAN_LIMITS.professional.infographicsPerMonth > 0 },
      { text: "Priority support (12h)", included: true },
    ],
    buttonText: "Upgrade to Professional",
    buttonVariant: "default" as const,
    popular: false,
  },
];

export default function LandingPricing({ onCtaClick }: LandingPricingProps) {
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");

  return (
    <section id="pricing" className="py-24 sm:py-32 border-t border-border/30">
      <div className="mx-auto max-w-7xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Start free, upgrade when you need more.
          </p>

          {/* Billing toggle */}
          <div className="flex items-center justify-center gap-3 mt-6">
            <span className={`text-sm font-medium ${billingInterval === "monthly" ? "text-foreground" : "text-muted-foreground"}`}>
              Monthly
            </span>
            <button
              onClick={() => setBillingInterval(billingInterval === "monthly" ? "yearly" : "monthly")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${billingInterval === "yearly" ? "bg-primary" : "bg-muted"}`}
              aria-label="Toggle billing interval"
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${billingInterval === "yearly" ? "translate-x-6" : "translate-x-1"}`} />
            </button>
            <span className={`text-sm font-medium ${billingInterval === "yearly" ? "text-foreground" : "text-muted-foreground"}`}>
              Yearly
            </span>
            <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 rounded-full">
              {`Save ${yearlyDiscountPercent()}%`}
            </span>
          </div>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {pricingPlans.map((plan, index) => {
            const IconComponent = plan.icon;
            const displayPrice = billingInterval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
            return (
              <motion.div
                key={plan.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className={`rounded-2xl border ${plan.popular ? "border-2 border-primary" : "border-border/50"} bg-card p-6 relative flex flex-col`}
              >
                {plan.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                      Most Popular
                    </span>
                  </div>
                )}
                
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                    <IconComponent className="h-4 w-4 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
                </div>
                
                <p className="text-sm text-muted-foreground mb-3">{plan.description}</p>
                
                <div className="mb-1">
                  <span className="text-3xl font-bold text-foreground">{displayPrice}</span>
                  <span className="text-muted-foreground">/month</span>
                </div>
                {billingInterval === "yearly" && plan.name !== "Free" && (
                  <p className="text-xs text-primary mb-4">Billed annually</p>
                )}
                {billingInterval === "monthly" && <div className="mb-4" />}
                
                <ul className="space-y-2.5 text-sm mb-6 flex-1">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-2">
                      {feature.included ? (
                        <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      ) : (
                        <X className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-0.5" />
                      )}
                      <span className={feature.included ? "text-muted-foreground" : "text-muted-foreground/50"}>
                        {feature.text}
                      </span>
                    </li>
                  ))}
                </ul>
                
                <Button
                  variant={plan.buttonVariant}
                  className="w-full"
                  onClick={() => onCtaClick(plan.buttonText)}
                >
                  {plan.buttonText}
                </Button>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
