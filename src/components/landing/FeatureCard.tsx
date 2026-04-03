import { useRef } from "react";
import { motion } from "framer-motion";
import { useTrackImpression } from "@/hooks/useAnalytics";
import type { FeatureItem } from "@/config/landingContent";

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
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.08, duration: 0.5 }}
      className="group relative rounded-2xl border border-white/10 bg-white/[0.04] p-6 backdrop-blur-sm transition-all duration-300 hover:border-primary/30 hover:bg-white/[0.07] hover:shadow-[0_8px_30px_-12px_rgba(17,196,208,0.15)]"
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
    </motion.div>
  );
}
