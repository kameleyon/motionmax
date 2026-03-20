import { useRef } from "react";
import { motion } from "framer-motion";
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
 * ────────────────────────────────────────────── */

export default function FaqSection() {
  const ref = useRef<HTMLDivElement>(null);
  useTrackImpression("faq_section_view", ref);

  return (
    <section
      ref={ref}
      id="faq"
      className="py-24 sm:py-32 border-t border-border/30"
    >
      <div className="mx-auto max-w-3xl px-6 sm:px-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-12"
        >
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
            Frequently Asked Questions
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Everything you need to know about MotionMax.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
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
        </motion.div>
      </div>
    </section>
  );
}
