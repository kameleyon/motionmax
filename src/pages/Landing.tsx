import { useState, useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { motion, AnimatePresence } from "framer-motion";
import { X, Menu } from "lucide-react";
import { PLAN_PRICES } from "@/config/products";
import { LANDING_FEATURES } from "@/config/landingContent";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { ThemeToggle } from "@/components/ThemeToggle";
import { trackEvent, useScrollDepthTracker } from "@/hooks/useAnalytics";
import SeoHead from "@/components/landing/SeoHead";
import FeatureCard from "@/components/landing/FeatureCard";
import TrustIndicators from "@/components/landing/TrustIndicators";
import FaqSection from "@/components/landing/FaqSection";
import featuresBackgroundDark from "@/assets/features-bg-dark.png";
import motionmaxLogo from "@/assets/motionmax-logo.png";
import motionMaxHeroLogo from "@/assets/motionmax-hero-logo.png";
import heroPromoVideo from "@/assets/hero-promo-optimized.mp4";
import heroVideoPoster from "@/assets/hero-video-poster.png";
import LandingPricing from "@/components/landing/LandingPricing";
import LandingCta from "@/components/landing/LandingCta";
import LandingAbout from "@/components/landing/LandingAbout";
import LandingFooter from "@/components/landing/LandingFooter";
import BeforeAfterComparison from "@/components/landing/BeforeAfterComparison";

export default function Landing() {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Analytics: track scroll depth milestones
  useScrollDepthTracker();

  // Focus trap for mobile menu
  useEffect(() => {
    if (!mobileMenuOpen) return;

    const menuElement = mobileMenuRef.current;
    if (!menuElement) return;

    // Get all focusable elements within the menu
    const focusableElements = menuElement.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])'
    );
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    // Focus first element when menu opens
    firstFocusable?.focus();

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        // Shift + Tab: moving backwards
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        // Tab: moving forwards
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

  // Respect prefers-reduced-motion and data-saver preferences before autoplaying video
  const prefersReducedMotion = typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const saveData = typeof navigator !== "undefined"
    && (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const showVideo = !videoError && !prefersReducedMotion && !saveData;

  /** Navigate to auth and fire analytics event */
  function handleCta(label: string) {
    trackEvent("cta_click", { cta_label: label, page: "landing" });
    const mode = label === "Sign In" || label === "Sign In Mobile" ? "signin" : "signup";
    navigate(`/auth?mode=${mode}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(185,30%,95%)] via-[hsl(185,25%,97%)] to-[hsl(180,20%,98%)] dark:bg-none dark:bg-background">
      <SeoHead />

      {/* Navigation with frosted glass effect */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-background/70 backdrop-blur-md border-b border-border/30">
        <div className="mx-auto flex h-16 sm:h-20 max-w-6xl items-center justify-between px-6 sm:px-8">
          <img src={motionmaxLogo} alt="MotionMax" className="h-8 sm:h-10 w-auto" />
          
          <nav className="hidden items-center gap-8 md:flex">
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
            <ThemeToggle />
            <Button
              ref={menuToggleRef}
              variant="ghost"
              size="icon"
              className="md:hidden rounded-full h-9 w-9"
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
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="md:hidden overflow-hidden border-t border-border/30 bg-background/95 backdrop-blur-md"
            >
              <div className="flex flex-col gap-1 px-6 py-4">
                <a href="#features" onClick={() => setMobileMenuOpen(false)} className="py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  Features
                </a>
                <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  Pricing
                </a>
                <a href="#faq" onClick={() => setMobileMenuOpen(false)} className="py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  FAQ
                </a>
                <a href="#about" onClick={() => setMobileMenuOpen(false)} className="py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  About
                </a>
                <div className="pt-2 border-t border-border/30 mt-2">
                  <Button
                    className="w-full rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                    onClick={() => { setMobileMenuOpen(false); handleCta("Sign In Mobile"); }}
                  >
                    Sign In
                  </Button>
                </div>
              </div>
            </motion.nav>
          )}
        </AnimatePresence>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center pt-32 md:pt-40 xl:pt-16">
        <div className="mx-auto max-w-7xl px-6 sm:px-8 w-full pb-16 md:pb-24">
          <div className="flex flex-col xl:grid xl:grid-cols-2 gap-8 xl:gap-16 items-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="max-w-2xl text-center xl:text-left"
            >
              <img 
                src={motionMaxHeroLogo} 
                alt="MotionMax" 
                className="w-full max-w-sm sm:max-w-md md:max-w-lg xl:max-w-xl mx-auto xl:mx-0"
              />
              
              <p className="mt-8 text-3xl sm:text-4xl md:text-5xl font-medium leading-tight uppercase tracking-wide text-foreground/85">
                Turn Text Into Engaging Visual Content.
              </p>
              
              <Button
                size="lg"
                className="mt-10 rounded-lg bg-primary px-10 py-7 text-lg font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => handleCta("Try for Free")}
              >
                Try for Free
              </Button>
              <p className="mt-4 text-sm text-muted-foreground">
                Free to start · Paid plans from {PLAN_PRICES.starter.monthly}/mo · No credit card required
              </p>
            </motion.div>

            {/* Hero Video with error fallback */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="w-full max-w-2xl"
            >
              <div className="w-full rounded-2xl shadow-2xl overflow-hidden">
                {!showVideo ? (
                  <img
                    src={heroVideoPoster}
                    alt="MotionMax — AI video creation"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <video
                    src={heroPromoVideo}
                    className="w-full h-full"
                    autoPlay
                    loop
                    muted
                    playsInline
                    poster={heroVideoPoster}
                    onError={() => setVideoError(true)}
                  />
                )}
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Features Section — theme-aware background */}
      <section
        id="features"
        className={`py-24 sm:py-32 relative overflow-hidden ${isDark ? "" : "bg-muted/30"}`}
        style={isDark ? {
          backgroundImage: `url(${featuresBackgroundDark})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        } : {}}
      >
        <div className="mx-auto max-w-6xl px-6 sm:px-8 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className={`text-3xl sm:text-4xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-foreground'}`}>
              Why MotionMax?
            </h2>
            <p className={`mt-4 text-lg max-w-2xl mx-auto ${isDark ? 'text-white/90' : 'text-muted-foreground'}`}>
              From idea to polished content in minutes. Our AI handles the heavy lifting so you can focus on your message.
            </p>
          </motion.div>

          <div className="grid gap-6 md:grid-cols-3">
            {LANDING_FEATURES.map((feature, index) => (
              <FeatureCard key={feature.title} feature={feature} index={index} />
            ))}
          </div>
        </div>
      </section>

      {/* Trust Indicators */}
      <TrustIndicators />

      {/* Before/After Comparison — time-saved metric */}
      <BeforeAfterComparison />

      {/* Pricing Section */}
      <LandingPricing onCtaClick={handleCta} />

      {/* CTA Section */}
      <LandingCta onCtaClick={handleCta} />

      {/* FAQ Section */}
      <FaqSection />

      {/* About Section */}
      <LandingAbout />

      {/* Footer */}
      <LandingFooter />
    </div>
  );
}
