/**
 * Shared hook for workspace subscription validation and upgrade modals.
 * Eliminates duplicate subscription/modal state across all workspace components.
 */
import { useState, useCallback } from "react";
import { useSubscription, validateGenerationAccess, PLAN_LIMITS } from "@/hooks/useSubscription";
import { toast } from "sonner";
import type { PlanTier, ValidationResult } from "@/lib/planLimits";

type SuspendedStatus = "past_due" | "unpaid" | "canceled";

interface SubscriptionModalState {
  showUpgradeModal: boolean;
  upgradeReason: string;
  showSuspendedModal: boolean;
  suspendedStatus: SuspendedStatus;
}

interface ValidateOptions {
  projectType: "doc2video" | "storytelling" | "smartflow" | "cinematic";
  length: string;
  format: string;
  hasBrandMark?: boolean;
  hasCustomStyle?: boolean;
}

interface WorkspaceSubscriptionReturn {
  /** Current plan tier */
  plan: PlanTier;
  /** Current credit balance */
  creditsBalance: number;
  /** Subscription status string */
  subscriptionStatus: string | null;
  /** Plan limits for current tier */
  limits: (typeof PLAN_LIMITS)[PlanTier];
  /** Re-fetch subscription state from server */
  checkSubscription: () => Promise<void>;

  /** Modal state */
  modalState: SubscriptionModalState;
  /** Close upgrade modal */
  closeUpgradeModal: () => void;
  /** Close suspended modal */
  closeSuspendedModal: () => void;

  /**
   * Validate whether the user can generate. Shows the correct modal and
   * returns `true` if generation should proceed, `false` if blocked.
   */
  guardGeneration: (opts: ValidateOptions) => boolean;
}

export function useWorkspaceSubscription(): WorkspaceSubscriptionReturn {
  const { plan, creditsBalance, subscriptionStatus, subscriptionEnd, checkSubscription } = useSubscription();

  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState("");
  const [showSuspendedModal, setShowSuspendedModal] = useState(false);
  const [suspendedStatus, setSuspendedStatus] = useState<SuspendedStatus>("past_due");

  const limits = PLAN_LIMITS[plan];

  const closeUpgradeModal = useCallback(() => setShowUpgradeModal(false), []);
  const closeSuspendedModal = useCallback(() => setShowSuspendedModal(false), []);

  const guardGeneration = useCallback(
    (opts: ValidateOptions): boolean => {
      // Check for suspended subscription first
      if (subscriptionStatus === "past_due" || subscriptionStatus === "unpaid") {
        setSuspendedStatus(subscriptionStatus as SuspendedStatus);
        setShowSuspendedModal(true);
        return false;
      }

      const validation: ValidationResult = validateGenerationAccess(
        plan,
        creditsBalance,
        opts.projectType,
        opts.length,
        opts.format,
        opts.hasBrandMark,
        opts.hasCustomStyle,
        subscriptionStatus || undefined,
        subscriptionEnd,
      );

      if (!validation.canGenerate) {
        toast.error("Cannot Generate", { description: validation.error });
        setUpgradeReason(validation.error || "Please upgrade your plan to continue.");
        setShowUpgradeModal(true);
        return false;
      }

      return true;
    },
    [plan, creditsBalance, subscriptionStatus, subscriptionEnd],
  );

  return {
    plan,
    creditsBalance,
    subscriptionStatus,
    limits,
    checkSubscription,
    modalState: {
      showUpgradeModal,
      upgradeReason,
      showSuspendedModal,
      suspendedStatus,
    },
    closeUpgradeModal,
    closeSuspendedModal,
    guardGeneration,
  };
}
