/** Experiment registry. Add new experiments here. */
export interface Experiment {
  id: string;
  /** Ordered variant names; index 0 is always "control". */
  variants: string[];
  /** Fraction of visitors enrolled (0–1). Default 1.0. */
  trafficFraction?: number;
}

export const EXPERIMENTS = {
  landing_hero_cta: {
    id: "landing_hero_cta",
    variants: ["control", "value_cta"],
  },
  landing_pricing_headline: {
    id: "landing_pricing_headline",
    variants: ["control", "roi_headline"],
  },
} satisfies Record<string, Experiment>;

export type ExperimentId = keyof typeof EXPERIMENTS;
