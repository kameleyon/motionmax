import { useRef } from "react";
import { TRUST_INDICATORS } from "@/config/landingContent";
import { useTrackImpression } from "@/hooks/useAnalytics";

/* ──────────────────────────────────────────────
 * Trust / social-proof strip shown on the landing
 * page between features and pricing.
 *
 * §5 PERF-009 fix (2026-05-10): swapped framer-motion fade-ins for the
 * .animate-fade-in-up CSS keyframe class, with stagger via inline
 * `animationDelay`. See LandingCta.tsx for the full rationale.
 * ────────────────────────────────────────────── */

export default function TrustIndicators() {
  const ref = useRef<HTMLDivElement>(null);
  useTrackImpression("trust_section_view", ref);

  return (
    <section ref={ref} className="py-14 sm:py-18 bg-white/[0.02]">
      <div className="mx-auto max-w-6xl px-6 sm:px-8">
        <div className="animate-fade-in-up text-center mb-12">
          <h2 className="type-h1 tracking-tight text-foreground">
            Trusted by creators worldwide
          </h2>
        </div>

        <div className="grid gap-8 sm:grid-cols-3">
          {TRUST_INDICATORS.map((item, index) => {
            const IconComponent = item.icon;
            return (
              <div
                key={item.label}
                className="animate-fade-in-up flex flex-col items-center text-center gap-3"
                style={{ animationDelay: `${index * 0.1}s` }}
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
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
