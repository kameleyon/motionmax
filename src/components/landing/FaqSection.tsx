import { useRef } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { LANDING_FAQ } from "@/config/landingContent";
import { useTrackImpression } from "@/hooks/useAnalytics";

/* ──────────────────────────────────────────────
 * FAQ accordion section.
 * Content is driven by src/config/landingContent.ts
 * so marketing copy can be updated without
 * touching component code.
 *
 * §5 PERF-009 fix (2026-05-10): the heading + accordion wrapper used
 * framer-motion fade-ins. Replaced with the .animate-fade-in-up CSS
 * keyframe class for a 168 KB JS payload reduction across the landing
 * chunk. See LandingCta.tsx for the full rationale.
 * ────────────────────────────────────────────── */

export default function FaqSection() {
  const ref = useRef<HTMLDivElement>(null);
  useTrackImpression("faq_section_view", ref);

  return (
    <section
      ref={ref}
      id="faq"
      className="py-16 sm:py-24 bg-white/[0.02]"
    >
      <div className="mx-auto max-w-3xl px-6 sm:px-8">
        <div className="animate-fade-in-up text-center mb-12">
          <h2 className="type-h1 tracking-tight text-foreground">
            Frequently Asked Questions
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Everything you need to know about MotionMax.
          </p>
        </div>

        <div className="animate-fade-in-up" style={{ animationDelay: "0.08s" }}>
          <Accordion type="single" collapsible className="w-full">
            {LANDING_FAQ.map((faq, index) => (
              <AccordionItem key={index} value={`faq-${index}`}>
                <AccordionTrigger className="text-left text-base">
                  {faq.question}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground leading-relaxed">
                  {faq.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  );
}
