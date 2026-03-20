import { useRef } from "react";
import { motion } from "framer-motion";
import { useTrackImpression } from "@/hooks/useAnalytics";
import type { FeatureItem } from "@/config/landingContent";

/* ──────────────────────────────────────────────
 * Single feature card used in the Features grid.
 * Tracks an impression event when scrolled into view.
 * ────────────────────────────────────────────── */

interface FeatureCardProps {
  feature: FeatureItem;
  index: number;
}

export default function FeatureCard({ feature, index }: FeatureCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const IconComponent = feature.icon;

  useTrackImpression("feature_view", ref, { feature_title: feature.title });

  return (
    <motion.div
      ref={ref}
      key={feature.title}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.1 }}
      className="text-center p-6 rounded-2xl bg-black/25 backdrop-blur-sm border border-white/20 shadow-lg"
    >
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20">
        <IconComponent className="h-7 w-7 text-white" />
      </div>
      <h3 className="text-lg font-semibold text-white mb-3">
        {feature.title}
      </h3>
      <p className="text-sm text-white/90 leading-relaxed">
        {feature.description}
      </p>
    </motion.div>
  );
}
