import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { motion } from "framer-motion";
import PageSeo from "@/components/PageSeo";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Lock, CreditCard, RefreshCcw } from "lucide-react";
import { AppHeader } from "@/components/layout/AppHeader";
import { useSubscription } from "@/hooks/useSubscription";
import { yearlyDiscountPercent } from "@/config/products";
import { BillingToggle } from "@/components/pricing/BillingToggle";
import { PLANS, CREDIT_PACKAGES } from "@/config/pricingPlans";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
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

import PlanCardGrid from "@/components/pricing/PlanCardGrid";
import CreditBreakdownTable from "@/components/pricing/CreditBreakdownTable";
import RoiCalculator from "@/components/pricing/RoiCalculator";
import CreditTopUp from "@/components/pricing/CreditTopUp";
import EnterpriseContactModal from "@/components/pricing/EnterpriseContactModal";

function getCheckoutErrorMessage(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("rate") || msg.includes("too many"))
    return "Too many attempts. Please wait a moment before trying again.";
  if (msg.includes("already") || msg.includes("active sub") || msg.includes("existing"))
    return "You may already have an active subscription. Visit your billing portal to manage it.";
  if (msg.includes("network") || msg.includes("failed to fetch") || msg.includes("connection"))
    return "Connection error. Check your internet connection and try again.";
  return "Unable to start checkout. Please try again or contact support@motionmax.io.";
}

export default function Pricing() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { plan: currentPlan, createCheckout, openCustomerPortal } = useSubscription();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [loadingCredits, setLoadingCredits] = useState<number | null>(null);
  const [showDowngradeDialog, setShowDowngradeDialog] = useState(false);
  const [showEnterpriseModal, setShowEnterpriseModal] = useState(false);
  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("monthly");

  const handleDowngrade = async () => {
    try {
      setLoadingPlan("free");
      setShowDowngradeDialog(false);
      await openCustomerPortal();
    } catch (error) {
      toast.error("Error", { description: error instanceof Error ? error.message : "Failed to open billing portal" });
    } finally {
      setLoadingPlan(null);
    }
  };

  const handleSubscribe = async (planId: string, priceId: string | null) => {
    if (!priceId) return;

    if (!user) {
      toast.error("Sign in required", { description: "Please sign in to subscribe to a plan" });
      navigate("/auth");
      return;
    }

    try {
      setLoadingPlan(planId);
      await createCheckout(priceId, "subscription");
    } catch (error) {
      toast.error("Error", { description: getCheckoutErrorMessage(error) });
    } finally {
      setLoadingPlan(null);
    }
  };

  const handleBuyCredits = async (credits: number, priceId: string) => {
    if (!user) {
      toast.error("Sign in required", { description: "Please sign in to purchase credits" });
      navigate("/auth");
      return;
    }

    try {
      setLoadingCredits(credits);
      await createCheckout(priceId, "payment");
    } catch (error) {
      toast.error("Error", { description: getCheckoutErrorMessage(error) });
    } finally {
      setLoadingCredits(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <PageSeo
        title="MotionMax Pricing — AI Video Plans & Credits"
        description="Choose the right MotionMax plan. Free tier available. Credit-based pricing for AI cinematic videos, explainers, and more."
        canonical="https://motionmax.io/pricing"
        breadcrumbs={[
          { name: "Home", item: "https://motionmax.io" },
          { name: "Pricing", item: "https://motionmax.io/pricing" },
        ]}
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "MotionMax AI Video Creator",
          "description": "AI-powered video creation platform with voice cloning, cinematic generation, and professional export.",
          "url": "https://motionmax.io/pricing",
          "brand": { "@type": "Brand", "name": "MotionMax" },
          "offers": [
            {
              "@type": "Offer",
              "name": "Creator Plan",
              "price": "29",
              "priceCurrency": "USD",
              "priceSpecification": {
                "@type": "UnitPriceSpecification",
                "price": "29",
                "priceCurrency": "USD",
                "billingDuration": "P1M"
              },
              "availability": "https://schema.org/InStock",
              "url": "https://motionmax.io/pricing"
            },
            {
              "@type": "Offer",
              "name": "Studio Plan",
              "price": "99",
              "priceCurrency": "USD",
              "priceSpecification": {
                "@type": "UnitPriceSpecification",
                "price": "99",
                "priceCurrency": "USD",
                "billingDuration": "P1M"
              },
              "availability": "https://schema.org/InStock",
              "url": "https://motionmax.io/pricing"
            }
          ]
        })}</script>
      </Helmet>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-background focus:text-foreground">Skip to content</a>
      <AppHeader className="z-50 backdrop-blur-md" />

      {/* Main Content */}
      <main id="main-content" className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
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
            <div className="flex justify-center mt-6">
              <BillingToggle
                value={billingInterval}
                onChange={setBillingInterval}
                discountPercent={yearlyDiscountPercent()}
              />
            </div>

            {/* Money-Back Guarantee */}
            <div className="flex items-center justify-center gap-2 mt-4">
              <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
              <span className="text-xs font-medium text-green-600 dark:text-green-400">
                7-Day Money-Back Guarantee — No questions asked
              </span>
            </div>
          </div>

          {/* Pricing Cards */}
          <PlanCardGrid
            plans={PLANS}
            currentPlan={currentPlan}
            billingInterval={billingInterval}
            loadingPlan={loadingPlan}
            onSubscribe={handleSubscribe}
            onDowngrade={() => setShowDowngradeDialog(true)}
            onEnterprise={() => setShowEnterpriseModal(true)}
          />

          {/* Trust badges */}
          <div className="flex flex-wrap items-center justify-center gap-6 mt-6 mb-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-green-500" />
              7-Day Money-Back Guarantee
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-4 w-4 text-green-500" />
              SSL / TLS encrypted
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CreditCard className="h-4 w-4 text-green-500" />
              Powered by Stripe
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCcw className="h-4 w-4 text-green-500" />
              Cancel anytime
            </span>
          </div>

          {/* Credit Breakdown Table */}
          <CreditBreakdownTable />

          {/* ROI Calculator */}
          <RoiCalculator />

          {/* Credit Top-Up Packs */}
          <CreditTopUp
            packages={CREDIT_PACKAGES}
            currentPlan={currentPlan}
            loadingCredits={loadingCredits}
            onBuyCredits={handleBuyCredits}
          />

          {/* FAQ Section */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="mt-16 sm:mt-20"
          >
            <h2 className="type-h2 text-center text-foreground mb-8">Frequently Asked Questions</h2>
            <div className="max-w-2xl mx-auto divide-y divide-border/50">
              {[
                {
                  q: "What are credits?",
                  a: `Credits are the currency used to generate videos on MotionMax. Each video generation costs a set number of credits depending on the length and type — for example, a short explainer costs 150 credits and a short cinematic costs 750. New accounts receive 150 one-time credits to get started with no credit card required.`,
                },
                {
                  q: "Can I cancel anytime?",
                  a: "Yes — you can cancel your subscription at any time from the billing portal. You'll keep your plan benefits until the end of your current billing period. No cancellation fees.",
                },
                {
                  q: "Do unused credits roll over?",
                  a: "Monthly subscription credits reset each billing cycle and do not roll over. However, credits purchased as top-up packs never expire and remain in your account until used.",
                },
                {
                  q: "Is there a free trial?",
                  a: "Yes — every new account starts with 10 free credits, no credit card required. You can upgrade to a paid plan at any time to get more credits and unlock premium features.",
                },
                {
                  q: "What happens if I run out of credits?",
                  a: "Video generation will be paused until you purchase additional credits or your plan renews. You can top up anytime with credit packs from the Pricing page.",
                },
              ].map(({ q, a }) => (
                <details key={q} className="group py-4">
                  <summary className="flex cursor-pointer items-center justify-between gap-4 text-sm font-medium text-foreground list-none">
                    {q}
                    <span className="text-muted-foreground transition-transform group-open:rotate-180">▾</span>
                  </summary>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{a}</p>
                </details>
              ))}
            </div>
          </motion.section>

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

      {/* Enterprise Contact Modal */}
      <EnterpriseContactModal
        open={showEnterpriseModal}
        onOpenChange={setShowEnterpriseModal}
      />
    </div>
  );
}
