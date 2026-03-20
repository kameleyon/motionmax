import { motion } from "framer-motion";
import { Plus, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CreditPackDef } from "@/config/pricingPlans";

interface CreditTopUpProps {
  packages: CreditPackDef[];
  currentPlan: string;
  loadingCredits: number | null;
  onBuyCredits: (credits: 15 | 50 | 150 | 500, priceId: string) => void;
}

export default function CreditTopUp({
  packages,
  currentPlan,
  loadingCredits,
  onBuyCredits,
}: CreditTopUpProps) {
  return (
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
        {packages.map((pkg, index) => {
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
                onClick={() => canBuy && !isLoading && onBuyCredits(pkg.credits, pkg.priceId)}
              >
                {pkg.popular && !pkg.bestValue && (
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
  );
}
