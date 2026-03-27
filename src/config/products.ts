import { Video, Headphones, Wallpaper, Film, LucideIcon } from "lucide-react";

export interface Product {
  id: "doc2video" | "storytelling" | "smartflow" | "cinematic";
  label: string;
  description: string;
  icon: LucideIcon;
  route: string;
  enabled: boolean;
}

export const PRODUCTS: Product[] = [
  {
    id: "doc2video",
    label: "Explainers",
    description: "Transform text scripts into videos",
    icon: Video,
    route: "/app/create?mode=doc2video",
    enabled: true,
  },
  {
    id: "storytelling",
    label: "Visual Stories",
    description: "Turn story ideas into visual narratives",
    icon: Headphones,
    route: "/app/create?mode=storytelling",
    enabled: true,
  },
  {
    id: "smartflow",
    label: "Smart Flow",
    description: "Create infographic slide decks",
    icon: Wallpaper,
    route: "/app/create?mode=smartflow",
    enabled: true,
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Scene-by-scene cinematic generation",
    icon: Film,
    route: "/app/create?mode=cinematic",
    enabled: true,
  },
];

export type ProductId = Product["id"];

// Single source of truth for subscription plan display prices
export const PLAN_PRICES = {
  free:         { monthly: "$0",     yearly: "$0" },
  starter:      { monthly: "$14.99", yearly: "$9.99" },
  creator:      { monthly: "$39.99", yearly: "$26.66" },
  professional: { monthly: "$89.99", yearly: "$59.99" },
  enterprise:   { monthly: "Custom", yearly: "Custom" },
} as const;

// Single source of truth for credit pack display prices
export const CREDIT_PACK_PRICES: Record<number, { price: string; perCredit: string }> = {
  15:  { price: "$11.99",  perCredit: "$0.80" },
  50:  { price: "$14.99",  perCredit: "$0.30" },
  150: { price: "$39.99",  perCredit: "$0.27" },
  500: { price: "$249.99", perCredit: "$0.50" },
};

/**
 * Computes the rounded integer discount percentage for yearly billing vs monthly.
 * All paid plans use the same discount rate so starter is used as the reference.
 */
export function yearlyDiscountPercent(): number {
  const monthly = parseFloat(PLAN_PRICES.starter.monthly.replace("$", ""));
  const yearly  = parseFloat(PLAN_PRICES.starter.yearly.replace("$", ""));
  return Math.round((1 - yearly / monthly) * 100);
}

/**
 * Calculates annual savings (monthly * 12) - (yearly * 12) for a given plan
 */
export function getAnnualSavings(plan: keyof typeof PLAN_PRICES): number {
  if (plan === "free" || plan === "enterprise") return 0;
  const monthly = parseFloat(PLAN_PRICES[plan].monthly.replace("$", ""));
  const yearly = parseFloat(PLAN_PRICES[plan].yearly.replace("$", ""));
  return Math.round((monthly - yearly) * 12);
}
