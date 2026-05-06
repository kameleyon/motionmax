import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { callCancelWithReason } from "./_shared/billingApi";
import { num } from "./_shared/format";

const REASONS = [
  "Too expensive",
  "Not using it enough",
  "Missing a feature",
  "Found another tool",
  "Just trying it out",
];

export function CancelRetentionModal({
  open,
  onClose,
  videosRendered,
  unusedCredits,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  videosRendered: number;
  unusedCredits: number;
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "keep" | "cancel">("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleAction(keep: boolean) {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    setBusy(keep ? "keep" : "cancel");
    try {
      const resp = await callCancelWithReason(session.access_token, reason, keep);
      if (resp?.kept_with_offer) {
        toast.success("Retention discount applied — you saved 50% for the next 3 months.");
      } else if (resp?.cancel_at_period_end) {
        toast("Subscription will cancel at the end of the current period.", {
          description: "You can re-subscribe anytime before then.",
        });
      }
      onChanged();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Could not update subscription", { description: msg });
    } finally {
      setBusy("");
    }
  }

  return createPortal(
    <div
      className="billing-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="billing-modal" role="dialog" aria-modal="true" aria-label="Cancel subscription">
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <div className="top">
          <h3>Wait — before you go.</h3>
          <p>
            You've rendered <b style={{ color: "#ECEAE4" }}>{num(videosRendered)} videos</b> on your plan.
            Cancelling now means losing access to premium features and{" "}
            <b style={{ color: "#ECEAE4" }}>{num(unusedCredits)} unused credits</b>.
          </p>
        </div>
        <div className="body">
          <div className="offer">
            <div className="ico">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path d="M12 2L4 6v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V6z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <div>
              <p className="t">Take 50% off your next 3 months instead.</p>
              <p className="d">Stay on your plan for half-price. One click below — code RETAIN50.</p>
            </div>
          </div>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".12em",
            textTransform: "uppercase", color: "#5A6268", marginBottom: 8,
          }}>
            Why are you leaving?
          </div>
          <div className="reasons">
            {REASONS.map((r) => (
              <label key={r}>
                <input
                  type="radio"
                  name="cancel-reason"
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {r}
              </label>
            ))}
          </div>
        </div>
        <div className="foot">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== ""}
            onClick={() => handleAction(false)}
            style={{ opacity: busy === "cancel" ? 0.6 : 1 }}
          >
            {busy === "cancel" ? "Cancelling…" : "Continue cancelling"}
          </button>
          <button
            type="button"
            className="btn-cyan"
            disabled={busy !== ""}
            onClick={() => handleAction(true)}
          >
            {busy === "keep" ? "Applying…" : "Take the 50% offer"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
