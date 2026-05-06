/**
 * Plan limits and credit costs configuration.
 *
 * Credit economy: 1 credit = 1 second of standard video output.
 * Cinematic uses a 5x multiplier (heavier compute).
 * Re-edits (image/video/audio regen) are FREE -- no extra credit cost.
 */

export type PlanTier = "free" | "creator" | "studio";

export interface PlanLimits {
  creditsPerMonth: number;
  dailyFreeCredits: number;
  allowedLengths: ("short" | "brief" | "presentation")[];
  allowedFormats: ("landscape" | "portrait")[];
  maxResolution: "720p" | "1080p" | "4k";
  voiceClones: number;
  allowBrandMark: boolean;
  allowCustomStyle: boolean;
  allowVoiceCloning: boolean;
  allowCharacterConsistency: boolean;
  priorityRendering: boolean;
  watermark: boolean;
  smartFlowLimit: number;
}

/** Map legacy plan names to new ones.
 *  Enterprise is no longer a sold tier; legacy enterprise rows fall
 *  through to studio limits (same monthly cap, no SLA promises). */
export function normalizePlanName(plan: string): PlanTier {
  switch (plan) {
    case "starter": return "creator";
    case "professional": return "studio";
    case "creator": return "creator";
    case "studio": return "studio";
    case "enterprise": return "studio";
    default: return "free";
  }
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> & { starter: PlanLimits; professional: PlanLimits } = {
  free: {
    creditsPerMonth: 0,
    dailyFreeCredits: 0,
    allowedLengths: ["short"],
    allowedFormats: ["landscape"],
    maxResolution: "720p",
    voiceClones: 0,
    allowBrandMark: false,
    allowCustomStyle: false,
    allowVoiceCloning: false,
    allowCharacterConsistency: false,
    priorityRendering: false,
    watermark: true,
    smartFlowLimit: 3,
  },
  creator: {
    creditsPerMonth: 500,
    dailyFreeCredits: 60,
    allowedLengths: ["short", "brief"],
    allowedFormats: ["landscape", "portrait"],
    maxResolution: "1080p",
    voiceClones: 1,
    allowBrandMark: false,
    allowCustomStyle: true,
    allowVoiceCloning: true,
    allowCharacterConsistency: false,
    priorityRendering: false,
    watermark: false,
    smartFlowLimit: 20,
  },
  studio: {
    creditsPerMonth: 2500,
    dailyFreeCredits: 150,
    allowedLengths: ["short", "brief", "presentation"],
    allowedFormats: ["landscape", "portrait"],
    maxResolution: "4k",
    voiceClones: 5,
    allowBrandMark: true,
    allowCustomStyle: true,
    allowVoiceCloning: true,
    allowCharacterConsistency: true,
    priorityRendering: true,
    watermark: false,
    smartFlowLimit: 999999,
  },
  // Legacy aliases so PLAN_LIMITS.starter / PLAN_LIMITS.professional don't crash
  get starter() { return this.creator; },
  get professional() { return this.studio; },
};

// ── Credit Cost Calculation ──────────────────────────────────────

/** Base seconds per video length */
const LENGTH_SECONDS: Record<string, number> = {
  short: 150,         // ~2.5 min (15 scenes x 10s)
  brief: 280,         // ~4.7 min (28 scenes x 10s)
  presentation: 360,  // ~6 min (36 scenes x 10s)
};

/** Compute multiplier per product type */
const PRODUCT_MULTIPLIER: Record<string, number> = {
  doc2video: 1,
  smartflow: 0.5,
  cinematic: 5,
};

/**
 * Calculate credits required for a generation.
 * Formula: estimated_seconds x product_multiplier
 */
export function getCreditsRequired(
  projectType: "doc2video" | "smartflow" | "cinematic",
  length: string,
): number {
  const seconds = LENGTH_SECONDS[length] || LENGTH_SECONDS.short;
  const multiplier = PRODUCT_MULTIPLIER[projectType] || 1;
  return Math.ceil(seconds * multiplier);
}

/** Get the multiplier for display purposes */
export function getMultiplier(projectType: string): number {
  return PRODUCT_MULTIPLIER[projectType] || 1;
}

/**
 * Flat per-run cost for autopost. Mirrors the
 * `public.autopost_credits_required(mode, length)` SQL function which
 * returns 45 unconditionally. Both frontend cost displays and the
 * SQL deduction read from the same constant so the UI estimate
 * always matches what the user is actually charged.
 */
export const AUTOPOST_CREDITS_PER_RUN = 45;

/** Plans that are allowed to use the autopost feature. Free is gated. */
export const AUTOPOST_ELIGIBLE_PLANS: ReadonlyArray<PlanTier> = [
  "creator",
  "studio",
] as const;

export function isAutopostEligible(plan: PlanTier): boolean {
  return AUTOPOST_ELIGIBLE_PLANS.includes(plan);
}

/** Get estimated duration in seconds */
export function getEstimatedSeconds(length: string): number {
  return LENGTH_SECONDS[length] || LENGTH_SECONDS.short;
}

// ── Validation ──────────────────────────────────────────────────

export interface ValidationResult {
  canGenerate: boolean;
  error?: string;
  upgradeRequired?: boolean;
  requiredPlan?: PlanTier;
}

export function validateGenerationAccess(
  plan: PlanTier,
  creditsBalance: number,
  projectType: "doc2video" | "smartflow" | "cinematic",
  length: string,
  format: string,
  hasBrandMark?: boolean,
  hasCustomStyle?: boolean,
  subscriptionStatus?: string,
  subscriptionEnd?: string | null,
): ValidationResult {
  if (subscriptionStatus === "past_due" || subscriptionStatus === "unpaid") {
    return {
      canGenerate: false,
      error: "Your subscription payment is overdue. Please update your payment method to continue creating.",
      upgradeRequired: true,
    };
  }

  if (subscriptionStatus === "canceled" && plan !== "free") {
    return {
      canGenerate: false,
      error: "Your subscription has been canceled. Please resubscribe to continue creating.",
      upgradeRequired: true,
    };
  }

  if (subscriptionEnd && plan !== "free") {
    const endDate = new Date(subscriptionEnd);
    if (endDate < new Date()) {
      return {
        canGenerate: false,
        error: "Your subscription has expired. Please renew to continue creating.",
        upgradeRequired: true,
      };
    }
  }

  const limits = PLAN_LIMITS[plan];
  const creditsRequired = getCreditsRequired(projectType, length);

  if (creditsBalance < creditsRequired) {
    const mult = PRODUCT_MULTIPLIER[projectType] || 1;
    const secs = Math.round(creditsRequired / mult);
    return {
      canGenerate: false,
      error: `Insufficient credits. You need ${creditsRequired} credits (${secs}s x ${mult}x) but have ${creditsBalance}. Add credits or upgrade your plan.`,
      upgradeRequired: true,
    };
  }

  const validFormats: readonly string[] = limits.allowedFormats;
  if (!validFormats.includes(format)) {
    return {
      canGenerate: false,
      error: `${format} format requires the Creator plan or higher.`,
      upgradeRequired: true,
      requiredPlan: "creator",
    };
  }

  if (hasBrandMark && !limits.allowBrandMark) {
    return {
      canGenerate: false,
      error: "Brand kit requires the Studio plan.",
      upgradeRequired: true,
      requiredPlan: "studio",
    };
  }

  if (hasCustomStyle && !limits.allowCustomStyle) {
    return {
      canGenerate: false,
      error: "Custom styles require the Creator plan or higher.",
      upgradeRequired: true,
      requiredPlan: "creator",
    };
  }

  if (projectType === "smartflow" && limits.smartFlowLimit === 0) {
    return {
      canGenerate: false,
      error: "Smart Flow is not available on the Free plan.",
      upgradeRequired: true,
      requiredPlan: "creator",
    };
  }

  return { canGenerate: true };
}
