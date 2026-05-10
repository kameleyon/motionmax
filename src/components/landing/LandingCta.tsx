import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ──────────────────────────────────────────────
 * Bottom call-to-action banner.
 *
 * §5 PERF-009 fix (2026-05-10): swapped framer-motion's <motion.div
 * initial/whileInView> for the .animate-fade-in-up CSS keyframe class
 * defined in src/index.css. This component used the animation runtime
 * for a single one-shot fade-up — every byte saved here multiplies
 * across the whole landing chunk now that framer-motion is no longer
 * pulled in by any landing component. The global
 * `prefers-reduced-motion: reduce` rule in index.css already collapses
 * the animation duration to ~0ms, so accessibility behaviour matches
 * what framer-motion was giving us.
 * ────────────────────────────────────────────── */

interface LandingCtaProps {
  onCtaClick: (label: string) => void;
}

export default function LandingCta({ onCtaClick }: LandingCtaProps) {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-3xl px-6 sm:px-8 text-center">
        <div className="animate-fade-in-up">
          <h2 className="type-h1 tracking-tight text-foreground">
            Ready to get started?
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Create your first video in minutes. No credit card required.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button
              size="hero"
              onClick={() => onCtaClick("Start Creating Free")}
            >
              Start Creating Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <a href="#pricing">
              <Button size="lg" variant="ghost" className="text-muted-foreground hover:text-foreground">
                View Pricing
              </Button>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
