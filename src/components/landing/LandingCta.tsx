import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ──────────────────────────────────────────────
 * Bottom call-to-action banner.
 * ────────────────────────────────────────────── */

interface LandingCtaProps {
  onCtaClick: (label: string) => void;
}

export default function LandingCta({ onCtaClick }: LandingCtaProps) {
  return (
    <section className="py-24 sm:py-32 border-t border-border/30">
      <div className="mx-auto max-w-3xl px-6 sm:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Ready to get started?
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Create your first video in minutes. No credit card required.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button
              size="lg"
              className="rounded-lg bg-primary px-8 py-6 text-base font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
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
        </motion.div>
      </div>
    </section>
  );
}
