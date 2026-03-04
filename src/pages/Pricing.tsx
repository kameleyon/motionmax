import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { 
  Check, 
  Zap, 
  Crown,
  Gem,
  Building2,
  Sparkles,
  Plus,
  Loader2,
  Info,
  X,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemedLogo } from "@/components/ThemedLogo";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useSubscription, STRIPE_PLANS, CREDIT_PACKS } from "@/hooks/useSubscription";
import { PLAN_LIMITS } from "@/lib/planLimits";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const plans = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: "$0",
    yearlyPrice: "$0",
    description: "Get started with basic features",
    icon: Sparkles,
    features: [
      `${PLAN_LIMITS.free.creditsPerMonth} credits/month`,
      "Short videos only (<2 min)",
      "720p quality",
      "5 basic visual styles",
      "Landscape format only",
      "No narration (silent/captions)",
      "Watermark on exports",
    ],
    excluded: [
      "Voice cloning",
      "Infographics",
      "Brand mark",
    ],
    cta: "Current Plan",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
  {
    id: "starter",
    name: "Starter",
    monthlyPrice: "$14.99",
    yearlyPrice: "$9.99",
    description: "Hobbyists & social creators",
    icon: Zap,
    features: [
      `${PLAN_LIMITS.starter.creditsPerMonth} credits/month`,
      "Short + Brief videos",
      "1080p quality",
      "10 visual styles",
      "All formats (16:9, 9:16, 1:1)",
      "Standard narration voices",
      "10 infographics/month",
      "No watermark",
      "Email support (48h)",
    ],
    excluded: [
      "Voice cloning",
      "Brand mark",
    ],
    cta: "Upgrade to Starter",
    popular: false,
    monthlyPriceId: STRIPE_PLANS.starter.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.starter.yearly.priceId,
  },
  {
    id: "creator",
    name: "Creator",
    monthlyPrice: "$39.99",
    yearlyPrice: "$26.66",
    description: "Content creators & small biz",
    icon: Crown,
    features: [
      `${PLAN_LIMITS.creator.creditsPerMonth} credits/month`,
      "All video lengths",
      "1080p quality",
      "All 13 styles + Custom",
      "All formats",
      "Full narration + voice effects",
      "1 voice clone",
      "50 infographics/month",
      "Brand mark",
      "Priority support (24h)",
    ],
    excluded: [],
    cta: "Upgrade to Creator",
    popular: true,
    monthlyPriceId: STRIPE_PLANS.creator.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.creator.yearly.priceId,
  },
  {
    id: "professional",
    name: "Professional",
    monthlyPrice: "$89.99",
    yearlyPrice: "$59.99",
    description: "Agencies & marketing teams",
    icon: Gem,
    features: [
      `${PLAN_LIMITS.professional.creditsPerMonth} credits/month`,
      "All video lengths",
      "4K quality",
      "All styles + premium effects",
      "Full narration + multilingual",
      "3 voice clones",
      "Unlimited infographics",
      "Full brand kit",
      "Priority support (12h)",
    ],
    excluded: [],
    cta: "Upgrade to Professional",
    popular: false,
    monthlyPriceId: STRIPE_PLANS.professional.monthly.priceId,
    yearlyPriceId: STRIPE_PLANS.professional.yearly.priceId,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyPrice: "Custom",
    yearlyPrice: "Custom",
    description: "Large organizations",
    icon: Building2,
    features: [
      "Unlimited credits (fair use)",
      "4K+ quality (up to 8K)",
      "Custom style development",
      "Custom voice training",
      "Unlimited voice clones",
      "White-label solution",
      "SSO/SAML integration",
      "On-premise available",
      "Custom SLA guarantee",
      "Dedicated manager",
      "24/7 premium support",
      "Onboarding training",
    ],
    excluded: [],
    cta: "Contact Sales",
    popular: false,
    monthlyPriceId: null,
    yearlyPriceId: null,
  },
];

const creditPackages = [
  { credits: 15 as const, price: "$11.99", perCredit: "$0.80", priceId: CREDIT_PACKS[15].priceId },
  { credits: 50 as const, price: "$14.99", perCredit: "$0.30", priceId: CREDIT_PACKS[50].priceId },
  { credits: 150 as const, price: "$39.99", perCredit: "$0.27", popular: true, bestValue: true, priceId: CREDIT_PACKS[150].priceId },
  { credits: 500 as const, price: "$249.99", perCredit: "$0.50", priceId: CREDIT_PACKS[500].priceId },
];

// Credit usage info
const creditInfo = [
  { type: "Short Video (<2 min)", credits: 1 },
  { type: "Brief Video (<5 min)", credits: 2 },
  { type: "Presentation (<10 min)", credits: 4 },
  { type: "Infographic", credits: 1 },
  { type: "Cinematic", credits: 12 },
];

export default function Pricing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const { plan: currentPlan, createCheckout, openCustomerPortal, isLoading: isLoadingSub } = useSubscription();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [loadingCredits, setLoadingCredits] = useState<number | null>(null);
  const [showDowngradeDialog, setShowDowngradeDialog] = useState(false);
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");

  const handleDowngrade = async () => {
    try {
      setLoadingPlan("free");
      setShowDowngradeDialog(false);
      await openCustomerPortal();
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to open billing portal",
        variant: "destructive",
      });
    } finally {
      setLoadingPlan(null);
    }
  };

  const handleSubscribe = async (planId: string, priceId: string | null) => {
    if (!priceId) return;
    
    if (!user) {
      toast({
        title: "Sign in required",
        description: "Please sign in to subscribe to a plan",
        variant: "destructive",
      });
      navigate("/auth");
      return;
    }

    try {
      setLoadingPlan(planId);
      await createCheckout(priceId, "subscription");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to start checkout",
        variant: "destructive",
      });
    } finally {
      setLoadingPlan(null);
    }
  };

  const handleBuyCredits = async (credits: 15 | 50 | 150 | 500, priceId: string) => {
    if (!user) {
      toast({
        title: "Sign in required",
        description: "Please sign in to purchase credits",
        variant: "destructive",
      });
      navigate("/auth");
      return;
    }

    try {
      setLoadingCredits(credits);
      await createCheckout(priceId, "payment");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to start checkout",
        variant: "destructive",
      });
    } finally {
      setLoadingCredits(null);
    }
  };

  const getPlanCta = (plan: typeof plans[0]) => {
    if (plan.id === currentPlan) {
      return "Current Plan";
    }
    if (plan.id === "free" && currentPlan !== "free") {
      return "Downgrade to Free";
    }
    return plan.cta;
  };

  const isPlanDisabled = (plan: typeof plans[0]) => {
    if (plan.id === "free") return currentPlan === "free";
    if (plan.id === currentPlan) return true;
    if (plan.id === "enterprise") return false;
    return false;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3 sm:gap-4">
            <SidebarTrigger className="lg:hidden">
              <Menu className="h-5 w-5 text-muted-foreground" />
            </SidebarTrigger>
            <ThemedLogo className="h-7 sm:h-8 w-auto" />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Hero */}
          <div className="text-center mb-8 sm:mb-12">
            <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-foreground">
              Choose Your Plan
            </h1>
            <p className="mt-2 sm:mt-3 text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto">
              Start free and scale as you grow. All plans include core features with images and narration.
            </p>

            {/* Billing Toggle */}
            <div className="flex items-center justify-center gap-3 mt-6">
              <span className={cn("text-sm font-medium", billingInterval === "monthly" ? "text-foreground" : "text-muted-foreground")}>Monthly</span>
              <button
                onClick={() => setBillingInterval(billingInterval === "monthly" ? "yearly" : "monthly")}
                className={cn(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  billingInterval === "yearly" ? "bg-primary" : "bg-muted"
                )}
              >
                <span className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                  billingInterval === "yearly" ? "translate-x-6" : "translate-x-1"
                )} />
              </button>
              <span className={cn("text-sm font-medium", billingInterval === "yearly" ? "text-foreground" : "text-muted-foreground")}>
                Yearly
              </span>
              <Badge variant="secondary" className="bg-primary/10 text-primary text-xs">Save 20%</Badge>
            </div>
          </div>

          {/* Pricing Cards */}
          <div className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {plans.map((plan, index) => {
              const Icon = plan.icon;
              const isCurrentPlan = plan.id === currentPlan;
              const isDisabled = isPlanDisabled(plan);
              const isLoading = loadingPlan === plan.id;
              
              return (
                <motion.div
                  key={plan.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Card
                    className={cn(
                      "relative h-full border-border/50 bg-card/50 shadow-sm transition-all hover:shadow-md flex flex-col",
                      plan.popular && "border-primary/50 bg-gradient-to-b from-primary/5 to-transparent",
                      isCurrentPlan && "ring-2 ring-primary"
                    )}
                  >
                    {plan.popular && !isCurrentPlan && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-primary text-primary-foreground">Most Popular</Badge>
                      </div>
                    )}
                    {isCurrentPlan && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-primary text-primary-foreground">Your Plan</Badge>
                      </div>
                    )}
                    <CardHeader className="pb-3">
                      <div className="flex items-center gap-2 mb-2">
                        <div className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg",
                          plan.popular || isCurrentPlan ? "bg-primary/20" : "bg-muted"
                        )}>
                          <Icon className={cn(
                            "h-4 w-4",
                            plan.popular || isCurrentPlan ? "text-primary" : "text-muted-foreground"
                          )} />
                        </div>
                        <CardTitle className="text-base sm:text-lg">{plan.name}</CardTitle>
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-2xl sm:text-3xl font-bold">
                          {billingInterval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice}
                        </span>
                        {plan.id !== "free" && plan.id !== "enterprise" && (
                          <span className="text-sm text-muted-foreground">
                            /mo
                          </span>
                        )}
                      </div>
                      {billingInterval === "yearly" && plan.id !== "free" && plan.id !== "enterprise" && (
                        <p className="text-xs text-primary">
                          Billed yearly (${(parseFloat(plan.yearlyPrice.replace("$", "")) * 12).toFixed(0)}/yr)
                        </p>
                      )}
                      <CardDescription className="text-xs sm:text-sm">{plan.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 flex-1 flex flex-col">
                      <ul className="space-y-1.5 flex-1">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-xs">
                            <Check className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                            <span className="text-muted-foreground">{feature}</span>
                          </li>
                        ))}
                        {plan.excluded.map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-xs">
                            <X className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 mt-0.5" />
                            <span className="text-muted-foreground/50 line-through">{feature}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="pt-2">
                        <Button
                          className={cn(
                            "w-full rounded-full text-sm",
                            plan.popular || isCurrentPlan
                              ? "bg-primary text-primary-foreground" 
                              : isDisabled 
                                ? "bg-muted text-muted-foreground cursor-not-allowed"
                                : "bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground"
                          )}
                          disabled={isDisabled || isLoading}
                          onClick={() => {
                            if (plan.id === "enterprise") {
                              window.open("mailto:support@motionmax.io?subject=Enterprise%20Inquiry", "_blank");
                            } else if (plan.id === "free" && currentPlan !== "free") {
                              setShowDowngradeDialog(true);
                            } else {
                              const priceId = billingInterval === "yearly" ? plan.yearlyPriceId : plan.monthlyPriceId;
                              if (priceId) handleSubscribe(plan.id, priceId);
                            }
                          }}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              Processing...
                            </>
                          ) : (
                            getPlanCta(plan)
                          )}
                        </Button>
                      </div>
                      {plan.id === "free" && currentPlan !== "free" && (
                        <div className="flex items-start gap-1.5 p-2 rounded-md bg-muted/50">
                          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          <p className="text-[10px] text-muted-foreground leading-tight">
                            When downgrading, you keep remaining credits until billing period ends. No refunds.
                          </p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>

          {/* Credit System Info */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-10 sm:mt-14"
          >
            <div className="text-center mb-6">
              <h2 className="text-lg sm:text-xl font-semibold text-foreground">
                How Credits Work
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Each content type uses a different amount of credits
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto">
              {creditInfo.map((item) => (
                <div
                  key={item.type}
                  className="flex items-center gap-2 px-3 py-2 rounded-full bg-muted/50 border border-border/50"
                >
                  <span className="text-xs text-muted-foreground">{item.type}</span>
                  <Badge variant="secondary" className="text-xs">
                    {item.credits} {item.credits === 1 ? "credit" : "credits"}
                  </Badge>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Credit Top-Up Section */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="mt-10 sm:mt-14"
          >
            <div className="text-center mb-6 sm:mb-8">
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground flex items-center justify-center gap-2">
                <Plus className="h-5 w-5 text-primary" />
                Credit Top-Up Packs
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Need more credits? Purchase additional packs anytime. Credits never expire.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Available for Starter tier and above
              </p>
            </div>

            <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4 max-w-3xl mx-auto">
              {creditPackages.map((pkg, index) => {
                const isLoading = loadingCredits === pkg.credits;
                const canBuy = currentPlan !== "free";
                
                return (
                  <motion.div
                    key={pkg.credits}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.6 + index * 0.05 }}
                  >
                    <Card
                      className={cn(
                        "relative border-border/50 bg-card/50 shadow-sm transition-all hover:shadow-md",
                        canBuy && "cursor-pointer hover:border-primary/50",
                        !canBuy && "opacity-60",
                        pkg.popular && "border-primary/50 ring-1 ring-primary/20",
                        pkg.bestValue && "border-primary ring-2 ring-primary/30"
                      )}
                      onClick={() => canBuy && !isLoading && handleBuyCredits(pkg.credits, pkg.priceId)}
                    >
                      {pkg.popular && (
                        <div className="absolute -top-2 right-2">
                          <Badge variant="secondary" className="text-[10px]">Popular</Badge>
                        </div>
                      )}
                      {pkg.bestValue && (
                        <div className="absolute -top-2 right-2">
                          <Badge className="bg-primary text-primary-foreground text-[10px]">Best Value</Badge>
                        </div>
                      )}
                      <CardContent className="p-4 text-center">
                        {isLoading ? (
                          <div className="py-4 flex flex-col items-center gap-2">
                            <Loader2 className="h-6 w-6 animate-spin text-primary" />
                            <span className="text-sm text-muted-foreground">Processing...</span>
                          </div>
                        ) : (
                          <>
                            <div className="text-2xl sm:text-3xl font-bold text-foreground">
                              {pkg.credits}
                            </div>
                            <div className="text-xs text-muted-foreground">credits</div>
                            <div className="mt-2 text-lg font-semibold text-foreground">
                              {pkg.price}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {pkg.perCredit}/credit
                            </div>
                            {!canBuy && (
                              <p className="mt-2 text-[10px] text-muted-foreground">
                                Upgrade to Starter+
                              </p>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>

          {/* Support Link */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="text-center mt-10 sm:mt-14"
          >
            <p className="text-sm text-muted-foreground">
              Have questions?{" "}
              <a href="mailto:support@motionmax.io" className="text-primary hover:underline">
                Contact support
              </a>
            </p>
          </motion.div>
        </motion.div>
      </main>

      {/* Downgrade Confirmation Dialog */}
      <AlertDialog open={showDowngradeDialog} onOpenChange={setShowDowngradeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Downgrade to Free Plan?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                When you downgrade, you'll keep your remaining credits and access until your current billing period ends or credits run out, whichever comes first.
              </p>
              <p className="font-medium text-foreground">
                No refunds will be provided for unused subscription time.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDowngrade}>
              Proceed to Billing Portal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
