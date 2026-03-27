import { useRef } from "react";
import { motion } from "framer-motion";
import { useTheme } from "next-themes";
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
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
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
      className={`text-center p-6 rounded-2xl backdrop-blur-sm border shadow-lg ${
        isDark
          ? 'bg-black/25 border-white/20'
          : 'bg-white/60 border-border'
      }`}
    >
      <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl ${
        isDark ? 'bg-white/20' : 'bg-primary/10'
      }`}>
        <IconComponent className={`h-7 w-7 ${isDark ? 'text-white' : 'text-primary'}`} />
      </div>
      <h3 className={`text-lg font-semibold mb-3 ${isDark ? 'text-white' : 'text-foreground'}`}>
        {feature.title}
      </h3>
      <p className={`text-sm leading-relaxed ${isDark ? 'text-white/90' : 'text-muted-foreground'}`}>
        {feature.description}
      </p>
    </motion.div>
  );
}
