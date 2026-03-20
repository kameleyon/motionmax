import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CREDIT_INFO } from "@/config/pricingPlans";
import { PLAN_LIMITS, type PlanTier } from "@/lib/planLimits";

/**
 * Calculates how many of each content type a plan can produce per month
 * based on included credits.
 */
function monthlyCapacity(creditsPerMonth: number, creditCost: number): string {
  if (creditsPerMonth >= 999999) return "∞";
  const count = Math.floor(creditsPerMonth / creditCost);
  return count.toString();
}

const TIER_LABELS: { id: PlanTier; label: string }[] = [
  { id: "free", label: "Free" },
  { id: "starter", label: "Starter" },
  { id: "creator", label: "Creator" },
  { id: "professional", label: "Pro" },
];

export default function CreditBreakdownTable() {
  return (
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

      {/* Quick credit pills */}
      <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto mb-6">
        {CREDIT_INFO.map((item) => (
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

      {/* Detailed breakdown table */}
      <Card className="max-w-3xl mx-auto border-border/50 bg-card/50 overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Content Type</th>
                  <th className="text-center px-3 py-3 text-xs font-medium text-muted-foreground">Credits</th>
                  {TIER_LABELS.map((tier) => (
                    <th key={tier.id} className="text-center px-3 py-3 text-xs font-medium text-muted-foreground">
                      {tier.label}
                      <span className="block text-[10px] font-normal">
                        {PLAN_LIMITS[tier.id].creditsPerMonth >= 999999
                          ? "∞ cr"
                          : `${PLAN_LIMITS[tier.id].creditsPerMonth} cr`}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CREDIT_INFO.map((item, idx) => (
                  <tr
                    key={item.type}
                    className={idx % 2 === 0 ? "bg-background" : "bg-muted/10"}
                  >
                    <td className="px-4 py-2.5 text-xs text-foreground font-medium">{item.type}</td>
                    <td className="text-center px-3 py-2.5">
                      <Badge variant="outline" className="text-[10px]">
                        {item.credits} {item.credits === 1 ? "cr" : "cr"}
                      </Badge>
                    </td>
                    {TIER_LABELS.map((tier) => (
                      <td key={tier.id} className="text-center px-3 py-2.5 text-xs text-muted-foreground">
                        {monthlyCapacity(PLAN_LIMITS[tier.id].creditsPerMonth, item.credits)}/mo
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2.5 border-t border-border/30">
            <p className="text-[10px] text-muted-foreground text-center">
              Capacity shows maximum if you only create that content type. Mix and match across types within your monthly credit allowance.
            </p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
