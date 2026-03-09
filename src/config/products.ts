import { Video, Headphones, LucideIcon } from "lucide-react";

export interface Product {
  id: "doc2video" | "storytelling";
  label: string;
  description: string;
  icon: LucideIcon;
  route: string;
  enabled: boolean;
}

export const PRODUCTS: Product[] = [
  {
    id: "doc2video",
    label: "Doc-to-Video",
    description: "Transform text scripts into videos",
    icon: Video,
    route: "/app/create?mode=doc2video",
    enabled: true,
  },
  {
    id: "storytelling",
    label: "Storytelling",
    description: "Turn story ideas into visual narratives",
    icon: Headphones,
    route: "/app/create?mode=storytelling",
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
