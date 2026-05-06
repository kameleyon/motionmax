import { motion } from "framer-motion";
import { Check, X, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PlanDef } from "@/config/pricingPlans";

interface PlanCardGridProps {
  plans: PlanDef[];
  currentPlan: string;
  billingInterval: "monthly" | "yearly";
  loadingPlan: string | null;
  onSubscribe: (planId: string, priceId: string | null) => void;
  onDowngrade: () => void;
}

function getPlanCta(plan: PlanDef, currentPlan: string): string {
  if (plan.id === currentPlan) return "Current Plan";
  if (plan.id === "free" && currentPlan !== "free") return "Downgrade to Free";
  return plan.cta;
}

function isPlanDisabled(plan: PlanDef, currentPlan: string): boolean {
  if (plan.id === "free") return currentPlan === "free";
  if (plan.id === currentPlan) return true;
  return false;
}

export default function PlanCardGrid({
  plans,
  currentPlan,
  billingInterval,
  loadingPlan,
  onSubscribe,
  onDowngrade,
}: PlanCardGridProps) {
  return (
    <div className="grid gap-4 sm:gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
      {plans.map((plan, index) => {
        const Icon = plan.icon;
        const isCurrentPlan = plan.id === currentPlan;
        const isDisabled = isPlanDisabled(plan, currentPlan);
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
                  {plan.id !== "free" && (
                    <span className="text-sm text-muted-foreground">/mo</span>
                  )}
                </div>
                {billingInterval === "yearly" && plan.id !== "free" && (
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
                      if (plan.id === "free" && currentPlan !== "free") {
                        onDowngrade();
                      } else {
                        const priceId = billingInterval === "yearly" ? plan.yearlyPriceId : plan.monthlyPriceId;
                        if (priceId) onSubscribe(plan.id, priceId);
                      }
                    }}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Processing...
                      </>
                    ) : (
                      getPlanCta(plan, currentPlan)
                    )}
                  </Button>
                </div>
                {plan.id === "free" && currentPlan !== "free" && (
                  <div className="flex items-start gap-1.5 p-2 rounded-md bg-muted/50">
                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground leading-tight">
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
  );
}
