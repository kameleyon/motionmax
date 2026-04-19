import { Video, Headphones, Wallpaper, Film, LucideIcon } from "lucide-react";

export interface Product {
  id: "doc2video" | "smartflow" | "cinematic";
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
  free:       { monthly: "$0",     yearly: "$0" },
  creator:    { monthly: "$29",    yearly: "$19" },
  studio:     { monthly: "$99",    yearly: "$66" },
  enterprise: { monthly: "Custom", yearly: "Custom" },
} as const;

// Credit pack display prices
export const CREDIT_PACK_PRICES: Record<number, { price: string; perCredit: string }> = {
  300:   { price: "$9.99",  perCredit: "$0.033" },
  900:   { price: "$24.99", perCredit: "$0.028" },
  2500:  { price: "$59.99", perCredit: "$0.024" },
};

export function yearlyDiscountPercent(): number {
  const monthly = parseFloat(PLAN_PRICES.creator.monthly.replace("$", ""));
  const yearly  = parseFloat(PLAN_PRICES.creator.yearly.replace("$", ""));
  return Math.round((1 - yearly / monthly) * 100);
}

export function getAnnualSavings(plan: keyof typeof PLAN_PRICES): number {
  if (plan === "free" || plan === "enterprise") return 0;
  const monthly = parseFloat(PLAN_PRICES[plan].monthly.replace("$", ""));
  const yearly = parseFloat(PLAN_PRICES[plan].yearly.replace("$", ""));
  return Math.round((monthly - yearly) * 12);
}
