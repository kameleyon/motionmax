import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Menu, Play } from "lucide-react";
import { LANDING_FEATURES } from "@/config/landingContent";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useNavigate } from "react-router-dom";
import { trackEvent, useScrollDepthTracker } from "@/hooks/useAnalytics";
import { useForceDarkMode } from "@/hooks/useForceDarkMode";
import SeoHead from "@/components/landing/SeoHead";
import FeatureCard from "@/components/landing/FeatureCard";
import TrustIndicators from "@/components/landing/TrustIndicators";
import { Testimonials } from "@/components/landing/Testimonials";
import FaqSection from "@/components/landing/FaqSection";
import motionmaxLogo from "@/assets/motionmax-logo.png";
import styles from "./Landing.module.css";
import LandingPricing from "@/components/landing/LandingPricing";
import LandingCta from "@/components/landing/LandingCta";
import LandingAbout from "@/components/landing/LandingAbout";
import LandingFooter from "@/components/landing/LandingFooter";
import BeforeAfterComparison from "@/components/landing/BeforeAfterComparison";

export default function Landing() {
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [demoModalOpen, setDemoModalOpen] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Force dark mode on Landing — always dark
  useForceDarkMode();

  // Analytics: track scroll depth milestones
  useScrollDepthTracker();

  // Focus trap for mobile menu
  useEffect(() => {
    if (!mobileMenuOpen) return;

    const menuElement = mobileMenuRef.current;
    if (!menuElement) return;

    const focusableElements = menuElement.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    firstFocusable?.focus();

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    };

    const handleEscapeKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
        menuToggleRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    document.addEventListener('keydown', handleEscapeKey);

    return () => {
      document.removeEventListener('keydown', handleTabKey);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [mobileMenuOpen]);

  /** Navigate to auth and fire analytics event */
  function handleCta(label: string) {
    trackEvent("cta_click", { cta_label: label, page: "landing" });
    const mode = label === "Sign In" || label === "Sign In Mobile" ? "signin" : "signup";
    navigate(`/auth?mode=${mode}`);
  }

  return (
    <div className="min-h-screen bg-background">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-background focus:text-foreground">Skip to content</a>
      <SeoHead />

      <main id="main-content">
      {/* Navigation with frosted glass effect */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-background/70 backdrop-blur-md border-b border-border/30">
        <div className="mx-auto flex h-16 sm:h-20 max-w-6xl items-center justify-between px-6 sm:px-8">
          <img src={motionmaxLogo} alt="MotionMax home" className="h-8 sm:h-10 w-auto" />
          
          <nav aria-label="Main navigation" className="hidden items-center gap-8 md:flex">
            <a href="#features" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#pricing" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="#faq" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              FAQ
            </a>
            <a href="#about" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              About
            </a>
          </nav>
          
          <div className="flex items-center gap-3">
            <Button
              ref={menuToggleRef}
              variant="ghost"
              size="icon"
              className="md:hidden rounded-full h-11 w-11"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              className="hidden md:flex text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => handleCta("Sign In")}
            >
              Sign In
            </Button>
            <Button
              className="hidden md:flex rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
              onClick={() => handleCta("Get Started")}
            >
              Get Started
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.nav
              ref={mobileMenuRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="mobile-menu-heading"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="md:hidden overflow-hidden border-t border-border/30 bg-background/95 backdrop-blur-md"
            >
              <span id="mobile-menu-heading" className="sr-only">Navigation menu</span>
              <div className="flex flex-col gap-1 px-6 py-4">
                {[
                  { href: "#features", label: "Features" },
                  { href: "#pricing", label: "Pricing" },
                  { href: "#faq", label: "FAQ" },
                  { href: "#about", label: "About" },
                ].map(({ href, label }) => (
                  <button
                    key={href}
                    onClick={() => {
                      setMobileMenuOpen(false);
                      menuToggleRef.current?.focus();
                      // Wait for AnimatePresence close (~200ms) before
                      // scrolling — otherwise scrollIntoView fires while
                      // the menu is still collapsing, the page still has
                      // the menu height, and the landing position is off.
                      // Also manually subtract the fixed header height so
                      // the section title isn't hidden behind the topbar.
                      setTimeout(() => {
                        const target = document.querySelector(href) as HTMLElement | null;
                        if (!target) return;
                        const headerEl = document.querySelector("header");
                        const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 80;
                        const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 12;
                        window.scrollTo({ top, behavior: "smooth" });
                      }, 250);
                    }}
                    className="py-2.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {label}
                  </button>
                ))}
                <div className="pt-2 border-t border-border/30 mt-2">
                  <Button
                    className="w-full rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                    onClick={() => { setMobileMenuOpen(false); menuToggleRef.current?.focus(); handleCta("Sign In Mobile"); }}
                  >
                    Sign In
                  </Button>
                </div>
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* Hero Section — herobackground.webp with PNG fallback via image-set() (Landing.module.css) */}
      <section
        className={`relative min-h-[85vh] sm:min-h-screen flex items-center pt-16 sm:pt-20 md:pt-32 xl:pt-16 ${styles.heroBg}`}
      >
        {/* Dark overlay (70%) + blur for text dominance */}
        <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />


        <div className="relative z-10 mx-auto max-w-7xl px-6 sm:px-8 w-full pb-8 md:pb-24">
          <h1 className="sr-only">MotionMax &#x2013; AI Video Generation</h1>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-2xl mx-auto text-center"
          >
            <img
              src="/motion.png"
              alt=""
              aria-hidden="true"
              width={480}
              height={160}
              className="w-full max-w-[200px] sm:max-w-[300px] md:max-w-[400px] xl:max-w-[480px] mx-auto"
            />

            <p className="mt-4 text-base sm:text-lg font-semibold uppercase tracking-widest text-primary">
              AI Video Generator
            </p>

            <p className="mt-3 text-xl sm:text-2xl md:text-4xl font-medium leading-snug text-white/90">
              Cinematic visuals. Natural voiceover.<br className="hidden sm:block" />Seamless transitions. <span className="text-primary">From one idea.</span>
            </p>
            
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <Button
                size="lg"
                className="min-w-[140px]"
                onClick={() => handleCta("Try for Free")}
              >
                Try for Free
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="gap-2 min-w-[140px] border-white/20 text-white/80 hover:bg-white/10 hover:text-white"
                onClick={() => {
                  trackEvent("watch_demo_click", { location: "hero" });
                  setDemoModalOpen(true);
                }}
              >
                <Play className="h-4 w-4" />
                Watch Demo
              </Button>
            </div>

            {/* Trust / urgency row */}
            <p className="mt-4 text-sm text-white/60">
              Free to start&nbsp;·&nbsp;No credit card required&nbsp;·&nbsp;Used by 2,400+ marketers
            </p>

            {/* Social proof avatars */}
            <div className="mt-8 flex items-center justify-center gap-3">
              <div className="flex -space-x-2">
                {[1,2,3,4,5].map(i => (
                  <div key={i} className="h-7 w-7 rounded-full border-2 border-background bg-gradient-to-br from-primary/60 to-primary/30" />
                ))}
              </div>
              {/* TODO: replace 2,400+ with a real figure from your analytics/DB */}
              <p className="text-sm text-white/70">
                Join <span className="font-semibold text-white/90">2,400+</span> creators already making videos
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Product Demo Section */}
      <section id="demo" className="py-12 sm:py-20 bg-white/[0.02]">
        <div className="mx-auto max-w-4xl px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-8"
          >
            <span className="inline-block mb-3 text-xs font-medium uppercase tracking-widest text-primary">
              See It in Action
            </span>
            <h2 className="type-h1 tracking-tight text-foreground">
              From text to cinematic video in minutes
            </h2>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="relative rounded-xl overflow-hidden border border-border/50 bg-black aspect-video"
          >
            <iframe
              src="https://embed.app.guidde.com/playbooks/wvJwFaqbh66kuXS3hZ23ir?mode=videoOnly"
              title="Product walkthrough: creating an AI video from text in MotionMax"
              frameBorder="0"
              referrerPolicy="unsafe-url"
              allowFullScreen
              allow="clipboard-write"
              sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-forms allow-same-origin allow-presentation"
              className="w-full h-full rounded-xl"
            />
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3 }}
            className="text-center mt-4 text-sm text-muted-foreground"
          >
            Paste any topic. AI writes the script, generates visuals, adds voiceover, and renders your video.
          </motion.p>
        </div>
      </section>

      {/* Features Section */}
      <section
        id="features"
        className="py-16 sm:py-24 relative overflow-hidden"
      >
        {/* Subtle gradient background */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/[0.03] to-transparent" />

        <div className="mx-auto max-w-6xl px-6 sm:px-8 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <span className="inline-block mb-3 text-xs font-medium uppercase tracking-widest text-primary">
              Features
            </span>
            <h2 className="type-h1 tracking-tight text-white">
              Everything you need. Nothing you don't.
            </h2>
            <p className="mt-4 text-base max-w-xl mx-auto text-white/70">
              AI handles research, scriptwriting, visuals, voiceover, and editing. You bring the idea.
            </p>
          </motion.div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {LANDING_FEATURES.map((feature, index) => (
              <FeatureCard key={feature.title} feature={feature} index={index} />
            ))}
          </div>
        </div>
      </section>

      {/* Product Modes Showcase */}
      <section className="py-16 sm:py-24 relative bg-white/[0.02]">
        <div className="mx-auto max-w-6xl px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-12"
          >
            <span className="inline-block mb-3 text-xs font-medium uppercase tracking-widest text-primary">
              4 Ways to Create
            </span>
            <h2 className="type-h1 tracking-tight text-white">
              One platform. Four creative modes.
            </h2>
            <p className="mt-4 text-base max-w-xl mx-auto text-white/70">
              Pick the format that fits your content. Each mode is purpose-built.
            </p>
          </motion.div>

          <div className="grid gap-6 md:grid-cols-2">
            {[
              {
                title: "Cinematic",
                tag: "AI Video",
                description: "15 AI-generated video scenes with image-to-video transitions, camera motion, and natural voiceover. Paste an idea, get a cinematic short film.",
                example: "\"The untold story of Haiti's revolution\" → 2.5 min cinematic video",
                color: "from-primary/20 to-primary/5",
                borderColor: "hover:border-primary/40",
                mode: "cinematic",
              },
              {
                title: "Explainers",
                tag: "Doc to Video",
                description: "Turn articles, documents, or any text into narrated slideshow videos. Multiple images per scene with professional voiceover.",
                example: "\"Paste a 5-page report\" → 8 min narrated explainer video",
                color: "from-[#e4c875]/20 to-[#e4c875]/5",
                borderColor: "hover:border-[#e4c875]/40",
                mode: "doc2video",
              },
              {
                title: "Visual Stories",
                description: "AI writes the script from your story idea, generates scene images, and narrates with matched emotion. Full creative control over tone and style.",
                example: "\"A bedtime story about a brave robot\" → animated visual story",
                color: "from-[#0D99A8]/20 to-[#0D99A8]/5",
                borderColor: "hover:border-[#0D99A8]/40",
              },
              {
                title: "Smart Flow",
                tag: "Infographics",
                description: "Transform data and key insights into stunning visual infographics with optional narration. Perfect for social media content.",
                example: "\"Top 10 AI trends in 2026\" → visual infographic with voiceover",
                color: "from-[#D4A929]/20 to-[#D4A929]/5",
                borderColor: "hover:border-[#D4A929]/40",
                mode: "smartflow",
              },
            ].map((product, index) => (
              <motion.div
                key={product.mode}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className={`group relative rounded-2xl border border-white/10 bg-gradient-to-br ${product.color} p-6 sm:p-8 transition-all duration-300 ${product.borderColor}`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <span className="text-xs font-medium uppercase tracking-wider text-white/80">{product.tag}</span>
                    <h3 className="text-xl font-semibold text-white mt-1">{product.title}</h3>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-white/80 mb-4">
                  {product.description}
                </p>
                <div className="rounded-lg bg-black/30 px-4 py-2.5 mb-5">
                  <p className="text-xs text-white/80 italic">{product.example}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-white/20 text-white/80 hover:bg-white/10 hover:text-white"
                  onClick={() => handleCta(`Try ${product.title}`)}
                >
                  Try {product.title}
                  <span className="text-primary">→</span>
                </Button>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust Indicators */}
      <TrustIndicators />

      {/* Before/After Comparison — time-saved metric */}
      <BeforeAfterComparison />

      {/* Testimonials */}
      <Testimonials />

      {/* Pricing Section */}
      <LandingPricing onCtaClick={handleCta} />

      {/* CTA Section */}
      <LandingCta onCtaClick={handleCta} />

      {/* FAQ Section */}
      <FaqSection />

      {/* About Section */}
      <LandingAbout />

      </main>

      {/* Footer */}
      <LandingFooter />

      {/* Watch Demo modal — replaces the old scroll-to-#demo (which had
          no target anchor). Shows a short explainer of what MotionMax
          does; swap the <iframe> src for a real demo video once ready. */}
      <Dialog open={demoModalOpen} onOpenChange={setDemoModalOpen}>
        <DialogContent className="max-w-[min(92vw,880px)] w-full p-0 overflow-hidden bg-[#0A0D0F] border-white/10">
          <DialogHeader className="px-6 pt-5 pb-3 border-b border-white/10">
            <DialogTitle className="font-serif text-[20px] text-white">
              <span className="text-[#14C8CC]">Motion</span><span className="text-[#E4C875]">Max</span>
              <span className="text-white/60 font-sans text-[15px] ml-2">— 90-second demo</span>
            </DialogTitle>
          </DialogHeader>
          <div className="aspect-video w-full bg-black grid place-items-center">
            {/* Placeholder until a real demo MP4 is recorded.
                Swap the <div> block below for an <iframe> or <video>
                pointing at the final asset. */}
            <div className="text-center px-6 py-10">
              <div className="h-14 w-14 mx-auto rounded-full border border-white/20 grid place-items-center mb-4">
                <Play className="h-6 w-6 text-white/70" />
              </div>
              <p className="font-serif text-[18px] text-white mb-1">Demo video coming soon</p>
              <p className="font-mono text-[11px] tracking-wider uppercase text-white/50">
                Sign up free — make your first video in under 90 seconds
              </p>
              <Button
                className="mt-5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => {
                  setDemoModalOpen(false);
                  handleCta("Demo Modal CTA");
                }}
              >
                Try for Free
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
