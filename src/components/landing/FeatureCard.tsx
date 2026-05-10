import { useRef } from "react";
import { useTrackImpression } from "@/hooks/useAnalytics";
import type { FeatureItem } from "@/config/landingContent";

/* §5 PERF-009 fix (2026-05-10): fade-in via CSS keyframe instead of
 * framer-motion. Stagger is preserved through inline `animationDelay`
 * driven by the index prop. See LandingCta.tsx for the full rationale.
 */

interface FeatureCardProps {
  feature: FeatureItem;
  index: number;
}

export default function FeatureCard({ feature, index }: FeatureCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const IconComponent = feature.icon;

  useTrackImpression("feature_view", ref, { feature_title: feature.title });

  return (
    <div
      ref={ref}
      className="animate-fade-in-up group relative rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm transition-all duration-300 hover:border-primary/30 hover:bg-white/[0.07]"
      style={{ animationDelay: `${index * 0.08}s` }}
    >
      {/* Subtle top gradient line */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 transition-colors group-hover:bg-primary/20">
        <IconComponent className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-base font-semibold text-white mb-2">
        {feature.title}
      </h3>
      <p className="text-sm leading-relaxed text-white/60">
        {feature.description}
      </p>
    </div>
  );
}
