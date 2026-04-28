import { Zap, Crown, Gem, Building2, type LucideIcon } from "lucide-react";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { STRIPE_PLANS, CREDIT_PACKS } from "@/hooks/useSubscription";
import { PLAN_PRICES, CREDIT_PACK_PRICES } from "@/config/products";

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

export interface CreditPackDef {
  credits: number;
  price: string;
  perCredit: string;
  priceId: string;
  popular?: boolean;
  bestValue?: boolean;
  label?: string;
}

// Credit top-up packages — priceIds from stripeProducts.ts (CREDIT_PACKS imported at top via useSubscription)
export const CREDIT_PACKAGES = [
  { credits: 300,  price: "$9.99",  perCredit: "$0.033", priceId: CREDIT_PACKS[300].priceId },
  { credits: 900,  price: "$24.99", perCredit: "$0.028", priceId: CREDIT_PACKS[900].priceId },
  { credits: 2500, price: "$59.99", perCredit: "$0.024", priceId: CREDIT_PACKS[2500].priceId },
];

// Credit cost info for the pricing breakdown table
export const CREDIT_INFO = [
  { type: "Explainer", credits: 150, label: "~2.5 min", multiplier: "1x", note: "Image + TTS, standard compute" },
  { type: "Visual Story", credits: 150, label: "~2.5 min", multiplier: "1x", note: "Same as explainer" },
  { type: "Smart Flow", credits: 75, label: "~2.5 min", multiplier: "0.5x", note: "Static images, lighter compute" },
  { type: "Cinematic", credits: 750, label: "~2.5 min", multiplier: "5x", note: "AI video (Kling) + TTS + ASR + research" },
  { type: "Brief Explainer", credits: 280, label: "~4.7 min", multiplier: "1x", note: "Longer standard video" },
  { type: "Brief Cinematic", credits: 1400, label: "~4.7 min", multiplier: "5x", note: "Longer cinematic video" },
];

export const PLANS: PlanDef[] = [
  {
    id: "free",
    name: "Free Trial",
    monthlyPrice: PLAN_PRICES.free.monthly,
    yearlyPrice: PLAN_PRICES.free.yearly,
    description: "Try MotionMax with 150 credits",
    icon: Zap,
    features: [
      "150 credits (one-time)",
      "All video types accessible",
      "720p quality",
      "Landscape format",
      "5 basic visual styles",
      "3 Smart Flow infographics",
      "Watermark on exports",
    ],
    excluded: ["Voice cloning", "Brand kit", "Custom styles", "Priority rendering"],
    cta: "Start Free Trial",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
  {
    id: "creator",
    name: "Creator",
    monthlyPrice: PLAN_PRICES.creator.monthly,
    yearlyPrice: PLAN_PRICES.creator.yearly,
    description: "For content creators and social media",
    icon: Crown,
    features: [
      `${PLAN_LIMITS.creator.creditsPerMonth} credits/month + ${PLAN_LIMITS.creator.dailyFreeCredits} daily bonus`,
      "1 credit = 1 second (standard), 5x for cinematic",
      "All video types (Explainer, Cinematic, Stories, Smart Flow)",
      "1080p quality",
      "All formats (16:9, 9:16)",
      "All 23 visual styles + custom",
      "All 23 caption styles with ASR sync",
      "1 voice clone",
      "11 languages",
      "Free re-edits (image, video, audio)",
      "No watermark",
      "20 Smart Flow/month",
    ],
    excluded: ["Brand kit", "Character consistency", "Priority rendering"],
    cta: "Start Creating",
    popular: true,
    monthlyPriceId: STRIPE_PLANS.creator.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.creator.yearly.priceId,
  },
  {
    id: "studio",
    name: "Studio",
    monthlyPrice: PLAN_PRICES.studio.monthly,
    yearlyPrice: PLAN_PRICES.studio.yearly,
    description: "For agencies and professional teams",
    icon: Gem,
    features: [
      `${PLAN_LIMITS.studio.creditsPerMonth} credits/month + ${PLAN_LIMITS.studio.dailyFreeCredits} daily bonus`,
      "1 credit = 1 second (standard), 5x for cinematic",
      "All video types",
      "4K quality",
      "All formats",
      "All styles + premium effects",
      "All caption styles",
      "5 voice clones",
      "11 languages",
      "Free re-edits",
      "No watermark",
      "Full brand kit",
      "Character consistency",
      "Unlimited Smart Flow",
      "Priority rendering",
    ],
    excluded: [],
    cta: "Go Studio",
    popular: false,
    monthlyPriceId: STRIPE_PLANS.professional.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.professional.yearly.priceId,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyPrice: PLAN_PRICES.enterprise.monthly,
    yearlyPrice: PLAN_PRICES.enterprise.yearly,
    description: "Custom solutions for large teams",
    icon: Building2,
    features: [
      "Unlimited credits (fair use)",
      "4K+ quality",
      "Custom style development",
      "Custom voice training",
      "Unlimited voice clones",
      "White-label solution",
      "SSO/SAML integration",
      "Custom SLA",
      "Dedicated account manager",
      "24/7 premium support",
    ],
    excluded: [],
    cta: "Contact Sales",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
];
