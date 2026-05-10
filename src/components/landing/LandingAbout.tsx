/* ──────────────────────────────────────────────
 * About / company section on the landing page.
 *
 * §5 PERF-009 fix (2026-05-10): fade-in via CSS keyframe (.animate-
 * fade-in-up) instead of framer-motion. See LandingCta.tsx for the
 * full rationale.
 * ────────────────────────────────────────────── */

export default function LandingAbout() {
  return (
    <section id="about" className="py-14 sm:py-20">
      <div className="mx-auto max-w-4xl px-6 sm:px-8">
        <div className="animate-fade-in-up text-center space-y-6">
          <h2 className="type-h1 tracking-tight text-foreground">
            About MotionMax
          </h2>
          <p className="text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            MotionMax is an AI-powered content creation platform designed to transform the way you produce visual and audio content.
            Our mission is to empower creators, educators, and businesses with intuitive tools that turn ideas into professional-quality
            videos and audio experiences in minutes—not hours.
          </p>
          <p className="text-muted-foreground leading-relaxed max-w-2xl mx-auto">
            Built by a passionate team of engineers and creatives, MotionMax leverages cutting-edge AI to handle the heavy lifting,
            so you can focus on what matters most: your message.
          </p>
          <div className="pt-4">
            <p className="text-sm text-muted-foreground">
              Have questions? Reach out to us at{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline font-medium">
                support@motionmax.io
              </a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
