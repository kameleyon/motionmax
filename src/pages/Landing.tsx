import { useState } from "react";
import { useTheme } from "next-themes";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, Volume2, Clapperboard, ArrowRight, Check, X, Sparkles, Zap, Crown, Building2, Menu } from "lucide-react";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { PLAN_PRICES } from "@/config/products";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { ThemeToggle } from "@/components/ThemeToggle";
import featuresBackgroundDark from "@/assets/features-bg-dark.png";
import motionmaxLogo from "@/assets/motionmax-logo.png";
import motionMaxHeroLogo from "@/assets/motionmax-hero-logo.png";
import heroPromoVideo from "@/assets/hero-promo-optimized.mp4";
import heroVideoPoster from "@/assets/hero-video-poster.png";

const features = [
  {
    title: "Document to Video",
    description: "Transform your documents and text into engaging narrated videos with AI-generated visuals.",
    icon: FileText,
  },
  {
    title: "Natural Voiceovers",
    description: "Create professional audio with natural-sounding AI voices that bring your content to life.",
    icon: Volume2,
  },
  {
    title: "AI Video Generation",
    description: "Generate fully produced videos with AI visuals, scene-by-scene storytelling, and professional narration.",
    icon: Clapperboard,
  },
];

const pricingPlans = [
  {
    name: "Free",
    icon: Sparkles,
    monthlyPrice: PLAN_PRICES.free.monthly,
    yearlyPrice: PLAN_PRICES.free.yearly,
    description: "Get started with basic features",
    features: [
      { text: `${PLAN_LIMITS.free.creditsPerMonth} credits/month`, included: true },
      { text: "Short videos only (<2 min)", included: true },
      { text: "720p quality", included: true },
      { text: "5 basic visual styles", included: true },
      { text: PLAN_LIMITS.free.allowedFormats.length === 1
          ? `${PLAN_LIMITS.free.allowedFormats[0].charAt(0).toUpperCase() + PLAN_LIMITS.free.allowedFormats[0].slice(1)} format only`
          : PLAN_LIMITS.free.allowedFormats.map(f => f.charAt(0).toUpperCase() + f.slice(1)).join(", ").replace(/, ([^,]*)$/, " and $1") + " formats",
        included: true },
      { text: "Watermark on exports", included: false },
      { text: "Voice cloning", included: !PLAN_LIMITS.free.allowVoiceCloning },
      { text: "Infographics", included: PLAN_LIMITS.free.infographicsPerMonth > 0 },
    ],
    buttonText: "Get Started",
    buttonVariant: "outline" as const,
    popular: false,
  },
  {
    name: "Starter",
    icon: Zap,
    monthlyPrice: PLAN_PRICES.starter.monthly,
    yearlyPrice: PLAN_PRICES.starter.yearly,
    description: "Hobbyists & social creators",
    features: [
      { text: `${PLAN_LIMITS.starter.creditsPerMonth} credits/month`, included: true },
      { text: `${PLAN_LIMITS.starter.allowedLengths.map(l => l.charAt(0).toUpperCase() + l.slice(1)).join(" + ")} videos`, included: true },
      { text: "1080p quality", included: true },
      { text: "10 visual styles", included: true },
      { text: "All formats (16:9, 9:16, 1:1)", included: true },
      { text: "Standard narration voices", included: true },
      { text: "No watermark", included: true },
      { text: "Email support (48h)", included: true },
    ],
    buttonText: "Upgrade to Starter",
    buttonVariant: "outline" as const,
    popular: false,
  },
  {
    name: "Creator",
    icon: Crown,
    monthlyPrice: PLAN_PRICES.creator.monthly,
    yearlyPrice: PLAN_PRICES.creator.yearly,
    description: "Content creators & small biz",
    features: [
      { text: `${PLAN_LIMITS.creator.creditsPerMonth} credits/month`, included: true },
      { text: "All video lengths", included: true },
      { text: "1080p quality", included: true },
      { text: `All 13 styles${PLAN_LIMITS.creator.allowCustomStyle ? " + Custom" : ""}`, included: true },
      { text: "Full narration + voice effects", included: true },
      { text: `${PLAN_LIMITS.creator.voiceClones} voice clone`, included: PLAN_LIMITS.creator.allowVoiceCloning },
      { text: `${PLAN_LIMITS.creator.infographicsPerMonth} infographics/month`, included: PLAN_LIMITS.creator.infographicsPerMonth > 0 },
      { text: "Priority support (24h)", included: true },
    ],
    buttonText: "Upgrade to Creator",
    buttonVariant: "default" as const,
    popular: true,
  },
  {
    name: "Professional",
    icon: Building2,
    monthlyPrice: PLAN_PRICES.professional.monthly,
    yearlyPrice: PLAN_PRICES.professional.yearly,
    description: "Agencies & marketing teams",
    features: [
      { text: `${PLAN_LIMITS.professional.creditsPerMonth} credits/month`, included: true },
      { text: "4K quality", included: true },
      { text: "All styles + premium effects", included: true },
      { text: "Full narration + multilingual", included: true },
      { text: `${PLAN_LIMITS.professional.voiceClones} voice clones`, included: PLAN_LIMITS.professional.allowVoiceCloning },
      { text: "Unlimited infographics", included: PLAN_LIMITS.professional.infographicsPerMonth > 0 },
      { text: "Priority support (12h)", included: true },
    ],
    buttonText: "Upgrade to Professional",
    buttonVariant: "default" as const,
    popular: false,
  },
];

export default function Landing() {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");
  const [videoError, setVideoError] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(185,30%,95%)] via-[hsl(185,25%,97%)] to-[hsl(180,20%,98%)] dark:bg-none dark:bg-background">
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
            <a href="#about" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              About
            </a>
          </nav>
          
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden rounded-full h-9 w-9"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
            <Button
              variant="ghost"
              className="hidden md:flex text-sm font-medium text-muted-foreground hover:text-foreground"
              onClick={() => navigate("/auth")}
            >
              Sign In
            </Button>
            <Button
              className="hidden md:flex rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
              onClick={() => navigate("/auth")}
            >
              Get Started
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.nav
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
                <a href="#about" onClick={() => setMobileMenuOpen(false)} className="py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                  About
                </a>
                <div className="pt-2 border-t border-border/30 mt-2">
                  <Button
                    className="w-full rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                    onClick={() => { setMobileMenuOpen(false); navigate("/auth"); }}
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
                Turn Text Into Engaging Visual Contents.
              </p>
              
              <Button
                size="lg"
                className="mt-10 rounded-lg bg-primary px-10 py-7 text-lg font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
                onClick={() => navigate("/auth")}
              >
                Try for Free
              </Button>
            </motion.div>

            {/* Hero Video with error fallback */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="w-full max-w-2xl"
            >
              <div className="w-full rounded-2xl shadow-2xl overflow-hidden">
                {videoError ? (
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
        className={`py-24 sm:py-32 relative overflow-hidden ${isDark ? "" : "bg-slate-900"}`}
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
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
              Why MotionMax?
            </h2>
            <p className="mt-4 text-lg text-white/90 max-w-2xl mx-auto">
              From idea to polished content in minutes. Our AI handles the heavy lifting so you can focus on your message.
            </p>
          </motion.div>

          <div className="grid gap-6 md:grid-cols-3">
            {features.map((feature, index) => {
              const IconComponent = feature.icon;
              return (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.1 }}
                  className="text-center p-6 rounded-2xl bg-black/25 backdrop-blur-sm border border-white/20 shadow-lg"
                >
                  <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20">
                    <IconComponent className="h-7 w-7 text-white" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-3">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-white/90 leading-relaxed">
                    {feature.description}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-24 sm:py-32 border-t border-border/30">
        <div className="mx-auto max-w-7xl px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-10"
          >
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
              Simple, transparent pricing
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Start free, upgrade when you need more.
            </p>

            {/* Billing toggle */}
            <div className="flex items-center justify-center gap-3 mt-6">
              <span className={`text-sm font-medium ${billingInterval === "monthly" ? "text-foreground" : "text-muted-foreground"}`}>
                Monthly
              </span>
              <button
                onClick={() => setBillingInterval(billingInterval === "monthly" ? "yearly" : "monthly")}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${billingInterval === "yearly" ? "bg-primary" : "bg-muted"}`}
                aria-label="Toggle billing interval"
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${billingInterval === "yearly" ? "translate-x-6" : "translate-x-1"}`} />
              </button>
              <span className={`text-sm font-medium ${billingInterval === "yearly" ? "text-foreground" : "text-muted-foreground"}`}>
                Yearly
              </span>
              <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 rounded-full">
                Save 20%
              </span>
            </div>
          </motion.div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {pricingPlans.map((plan, index) => {
              const IconComponent = plan.icon;
              const displayPrice = billingInterval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
              return (
                <motion.div
                  key={plan.name}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.1 }}
                  className={`rounded-2xl border ${plan.popular ? "border-2 border-primary" : "border-border/50"} bg-card p-6 relative flex flex-col`}
                >
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                        Most Popular
                      </span>
                    </div>
                  )}
                  
                  <div className="flex items-center gap-2 mb-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                      <IconComponent className="h-4 w-4 text-primary" />
                    </div>
                    <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
                  </div>
                  
                  <p className="text-sm text-muted-foreground mb-3">{plan.description}</p>
                  
                  <div className="mb-1">
                    <span className="text-3xl font-bold text-foreground">{displayPrice}</span>
                    <span className="text-muted-foreground">/month</span>
                  </div>
                  {billingInterval === "yearly" && plan.name !== "Free" && (
                    <p className="text-xs text-primary mb-4">Billed annually</p>
                  )}
                  {billingInterval === "monthly" && <div className="mb-4" />}
                  
                  <ul className="space-y-2.5 text-sm mb-6 flex-1">
                    {plan.features.map((feature, i) => (
                      <li key={i} className="flex items-start gap-2">
                        {feature.included ? (
                          <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        ) : (
                          <X className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-0.5" />
                        )}
                        <span className={feature.included ? "text-muted-foreground" : "text-muted-foreground/50"}>
                          {feature.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                  
                  <Button
                    variant={plan.buttonVariant}
                    className="w-full"
                    onClick={() => navigate("/auth")}
                  >
                    {plan.buttonText}
                  </Button>
                </motion.div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA Section */}
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
                onClick={() => navigate("/auth")}
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

      {/* About Section */}
      <section id="about" className="py-20 sm:py-24 border-t border-border/30 bg-muted/30">
        <div className="mx-auto max-w-4xl px-6 sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center space-y-6"
          >
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
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
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/30 py-10">
        <div className="mx-auto flex max-w-6xl flex-col sm:flex-row items-center justify-between gap-4 px-6 sm:px-8">
          <img src={motionmaxLogo} alt="MotionMax" className="h-10 w-auto" />
          <p className="text-sm text-muted-foreground">
            © 2026 MotionMax. All rights reserved.
          </p>
          <nav className="flex items-center gap-5">
            <a href="/terms" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Terms of Service
            </a>
            <a href="/privacy" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Privacy Policy
            </a>
            <a href="/acceptable-use" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Acceptable Use
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
