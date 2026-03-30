import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { Calculator, TrendingDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PLAN_PRICES } from "@/config/products";

/**
 * Industry average cost of hiring a freelance video editor per video.
 * Source: typical rates for 2-5 min explainer/social videos (2024-2026).
 */
const EDITOR_COST_PER_VIDEO = 350;

/**
 * Average credits consumed per video (weighted blend of short/brief/presentation).
 * Short=1, Brief=2, Presentation=4 → weighted avg ≈ 2 credits.
 */
const AVG_CREDITS_PER_VIDEO = 2;

interface PlanOption {
  label: string;
  monthlyPrice: number;
  creditsIncluded: number;
  extraCreditCost: number; // price per credit if buying top-up (150-pack rate)
}

const PLAN_OPTIONS: PlanOption[] = [
  { label: "Creator", monthlyPrice: parseFloat(PLAN_PRICES.creator.monthly.replace("$", "")), creditsIncluded: 100, extraCreditCost: 0.27 },
  { label: "Professional", monthlyPrice: parseFloat(PLAN_PRICES.professional.monthly.replace("$", "")), creditsIncluded: 300, extraCreditCost: 0.27 },
];

export default function RoiCalculator() {
  const [videosPerMonth, setVideosPerMonth] = useState(10);
  const [selectedPlanIdx, setSelectedPlanIdx] = useState(0);

  const result = useMemo(() => {
    const plan = PLAN_OPTIONS[selectedPlanIdx];
    const totalCreditsNeeded = videosPerMonth * AVG_CREDITS_PER_VIDEO;
    const extraCredits = Math.max(0, totalCreditsNeeded - plan.creditsIncluded);
    const extraCost = extraCredits * plan.extraCreditCost;
    const motionMaxCost = plan.monthlyPrice + extraCost;
    const editorCost = videosPerMonth * EDITOR_COST_PER_VIDEO;
    const savings = editorCost - motionMaxCost;
    const savingsPercent = editorCost > 0 ? Math.round((savings / editorCost) * 100) : 0;
    const costPerVideo = videosPerMonth > 0 ? motionMaxCost / videosPerMonth : 0;

    return { motionMaxCost, editorCost, savings, savingsPercent, costPerVideo };
  }, [videosPerMonth, selectedPlanIdx]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.45 }}
      className="mt-10 sm:mt-14"
    >
      <div className="text-center mb-6">
        <h2 className="text-lg sm:text-xl font-semibold text-foreground flex items-center justify-center gap-2">
          <Calculator className="h-5 w-5 text-primary" />
          ROI Calculator
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          See how much you save compared to hiring a video editor
        </p>
      </div>

      <Card className="max-w-2xl mx-auto border-border/50 bg-card/50">
        <CardContent className="p-4 sm:p-6 space-y-5">
          {/* Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="roi-videos" className="text-xs font-medium text-foreground block mb-1.5">
                Videos per month
              </label>
              <input
                id="roi-videos"
                type="range"
                min={1}
                max={100}
                value={videosPerMonth}
                onChange={(e) => setVideosPerMonth(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>1</span>
                <span className="font-semibold text-foreground text-sm">{videosPerMonth}</span>
                <span>100</span>
              </div>
            </div>
            <div>
              <label htmlFor="roi-plan" className="text-xs font-medium text-foreground block mb-1.5">
                MotionMax Plan
              </label>
              <select
                id="roi-plan"
                value={selectedPlanIdx}
                onChange={(e) => setSelectedPlanIdx(Number(e.target.value))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {PLAN_OPTIONS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label} — ${p.monthlyPrice}/mo
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Results */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-muted/50 border border-border/50 p-3">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Freelance Editor</p>
              <p className="text-lg sm:text-xl font-bold text-foreground">
                ${result.editorCost.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">/month</p>
            </div>
            <div className="rounded-lg bg-primary/5 border border-primary/30 p-3">
              <p className="text-xs uppercase tracking-wider text-primary mb-1">MotionMax</p>
              <p className="text-lg sm:text-xl font-bold text-primary">
                ${result.motionMaxCost.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">
                ${result.costPerVideo.toFixed(2)}/video
              </p>
            </div>
            <div className="rounded-lg bg-green-500/5 border border-green-500/30 p-3">
              <p className="text-xs uppercase tracking-wider text-green-600 dark:text-green-400 mb-1">You Save</p>
              <p className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400 flex items-center justify-center gap-1">
                <TrendingDown className="h-4 w-4" />
                {result.savingsPercent}%
              </p>
              <p className="text-xs text-muted-foreground">
                ${result.savings.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Based on avg. freelance editor rate of ${EDITOR_COST_PER_VIDEO}/video and ~{AVG_CREDITS_PER_VIDEO} credits/video (blended average).
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}
