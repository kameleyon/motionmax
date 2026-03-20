/**
 * Shared workspace modals for subscription upgrade and suspended states.
 * Use with useWorkspaceSubscription hook to eliminate modal duplication
 * across workspace components.
 */
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import type { PlanTier } from "@/lib/planLimits";

interface WorkspaceModalsProps {
  plan: PlanTier;
  showUpgradeModal: boolean;
  upgradeReason: string;
  showSuspendedModal: boolean;
  suspendedStatus: "past_due" | "unpaid" | "canceled";
  onUpgradeModalChange: (open: boolean) => void;
  onSuspendedModalChange: (open: boolean) => void;
}

export function WorkspaceModals({
  plan,
  showUpgradeModal,
  upgradeReason,
  showSuspendedModal,
  suspendedStatus,
  onUpgradeModalChange,
  onSuspendedModalChange,
}: WorkspaceModalsProps) {
  return (
    <>
      <UpgradeRequiredModal
        open={showUpgradeModal}
        onOpenChange={onUpgradeModalChange}
        reason={upgradeReason}
        showCreditsOption={plan !== "free"}
      />
      <SubscriptionSuspendedModal
        open={showSuspendedModal}
        onOpenChange={onSuspendedModalChange}
        status={suspendedStatus}
      />
    </>
  );
}
