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
