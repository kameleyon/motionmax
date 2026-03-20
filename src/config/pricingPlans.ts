import { Sparkles, Zap, Crown, Gem, Building2, type LucideIcon } from "lucide-react";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { STRIPE_PLANS, CREDIT_PACKS } from "@/hooks/useSubscription";
import { PLAN_PRICES, CREDIT_PACK_PRICES } from "@/config/products";

/* ──────────────────────────────────────────────
 * Plan definitions
 * ────────────────────────────────────────────── */

export interface PlanDef {
  id: string;
  name: string;
  monthlyPrice: string;
  yearlyPrice: string;
  description: string;
  icon: LucideIcon;
  features: string[];
  excluded: string[];
  cta: string;
  popular: boolean;
  monthlyPriceId: string | null;
  yearlyPriceId: string | null;
}

export const PLANS: PlanDef[] = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: PLAN_PRICES.free.monthly,
    yearlyPrice: PLAN_PRICES.free.yearly,
    description: "Get started with basic features",
    icon: Sparkles,
    features: [
      `${PLAN_LIMITS.free.creditsPerMonth} credits/month`,
      "Short videos only (<2 min)",
      "720p quality",
      "5 basic visual styles",
      "Landscape format only",
      "No narration (silent/captions)",
      "Watermark on exports",
    ],
    excluded: ["Voice cloning", "Infographics", "Brand mark"],
    cta: "Current Plan",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPrice: PLAN_PRICES.starter.monthly,
    yearlyPrice: PLAN_PRICES.starter.yearly,
    description: "Hobbyists & social creators",
    icon: Zap,
    features: [
      `${PLAN_LIMITS.starter.creditsPerMonth} credits/month`,
      "Short + Brief videos",
      "1080p quality",
      "10 visual styles",
      "All formats (16:9, 9:16, 1:1)",
      "Standard narration voices",
      "10 infographics/month",
      "No watermark",
      "Email support (48h)",
    ],
    excluded: ["Voice cloning", "Brand mark"],
    cta: "Upgrade to Starter",
    popular: false,
    monthlyPriceId: STRIPE_PLANS.starter.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.starter.yearly.priceId,
  },
  {
    id: "creator",
    name: "Creator",
    monthlyPrice: PLAN_PRICES.creator.monthly,
    yearlyPrice: PLAN_PRICES.creator.yearly,
    description: "Content creators & small biz",
    icon: Crown,
    features: [
      `${PLAN_LIMITS.creator.creditsPerMonth} credits/month`,
      "All video lengths",
      "1080p quality",
      "All 13 styles + Custom",
      "All formats",
      "Full narration + voice effects",
      "1 voice clone",
      "50 infographics/month",
      "Brand mark",
      "Priority support (24h)",
    ],
    excluded: [],
    cta: "Upgrade to Creator",
    popular: true,
    monthlyPriceId: STRIPE_PLANS.creator.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.creator.yearly.priceId,
  },
  {
    id: "professional",
    name: "Professional",
    monthlyPrice: PLAN_PRICES.professional.monthly,
    yearlyPrice: PLAN_PRICES.professional.yearly,
    description: "Agencies & marketing teams",
    icon: Gem,
    features: [
      `${PLAN_LIMITS.professional.creditsPerMonth} credits/month`,
      "All video lengths",
      "4K quality",
      "All styles + premium effects",
      "Full narration + multilingual",
      "3 voice clones",
      "Unlimited infographics",
      "Full brand kit",
      "Priority support (12h)",
    ],
    excluded: [],
    cta: "Upgrade to Professional",
    popular: false,
    monthlyPriceId: STRIPE_PLANS.professional.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.professional.yearly.priceId,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyPrice: PLAN_PRICES.enterprise.monthly,
    yearlyPrice: PLAN_PRICES.enterprise.yearly,
    description: "Large organizations",
    icon: Building2,
    features: [
      "Unlimited credits (fair use)",
      "4K+ quality (up to 8K)",
      "Custom style development",
      "Custom voice training",
      "Unlimited voice clones",
      "White-label solution",
      "SSO/SAML integration",
      "On-premise available",
      "Custom SLA guarantee",
      "Dedicated manager",
      "24/7 premium support",
      "Onboarding training",
    ],
    excluded: [],
    cta: "Contact Sales",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
];

/* ──────────────────────────────────────────────
 * Credit pack definitions
 * ────────────────────────────────────────────── */

export interface CreditPackDef {
  credits: 15 | 50 | 150 | 500;
  price: string;
  perCredit: string;
  priceId: string;
  popular?: boolean;
  bestValue?: boolean;
}

export const CREDIT_PACKAGES: CreditPackDef[] = [
  { credits: 15, price: CREDIT_PACK_PRICES[15].price, perCredit: CREDIT_PACK_PRICES[15].perCredit, priceId: CREDIT_PACKS[15].priceId },
  { credits: 50, price: CREDIT_PACK_PRICES[50].price, perCredit: CREDIT_PACK_PRICES[50].perCredit, priceId: CREDIT_PACKS[50].priceId },
  { credits: 150, price: CREDIT_PACK_PRICES[150].price, perCredit: CREDIT_PACK_PRICES[150].perCredit, popular: true, bestValue: true, priceId: CREDIT_PACKS[150].priceId },
  { credits: 500, price: CREDIT_PACK_PRICES[500].price, perCredit: CREDIT_PACK_PRICES[500].perCredit, priceId: CREDIT_PACKS[500].priceId },
];

/* ──────────────────────────────────────────────
 * Credit cost per content type
 * ────────────────────────────────────────────── */

export const CREDIT_INFO = [
  { type: "Short Video (<2 min)", credits: 1 },
  { type: "Brief Video (<5 min)", credits: 2 },
  { type: "Presentation (<10 min)", credits: 4 },
  { type: "Infographic", credits: 1 },
  { type: "Cinematic", credits: 12 },
];
