import { useRef } from "react";
import { motion } from "framer-motion";
import { TRUST_INDICATORS } from "@/config/landingContent";
import { useTrackImpression } from "@/hooks/useAnalytics";

/* ──────────────────────────────────────────────
 * Trust / social-proof strip shown on the landing
 * page between features and pricing.
 * ────────────────────────────────────────────── */

export default function TrustIndicators() {
  const ref = useRef<HTMLDivElement>(null);
  useTrackImpression("trust_section_view", ref);

  return (
    <section ref={ref} className="py-16 sm:py-20 border-t border-border/30">
      <div className="mx-auto max-w-6xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Trusted by creators worldwide
          </h2>
        </motion.div>

        <div className="grid gap-8 sm:grid-cols-3">
          {TRUST_INDICATORS.map((item, index) => {
            const IconComponent = item.icon;
            return (
              <motion.div
                key={item.label}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="flex flex-col items-center text-center gap-3"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <IconComponent className="h-6 w-6 text-primary" />
                </div>
                <h3 className="text-base font-semibold text-foreground">
                  {item.label}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {item.detail}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
