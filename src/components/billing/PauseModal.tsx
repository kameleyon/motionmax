import { useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { callPauseSubscription } from "./_shared/billingApi";

export function PauseModal({
  open,
  onClose,
  onPaused,
}: {
  open: boolean;
  onClose: () => void;
  onPaused: () => void;
}) {
  const { session } = useAuth();
  const [months, setMonths] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function submit() {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    setBusy(true);
    try {
      await callPauseSubscription(session.access_token, months);
      toast.success(`Subscription paused for ${months} month${months > 1 ? "s" : ""}.`, {
        description: "Billing stops now. Your credits remain on your account.",
      });
      onPaused();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Could not pause", { description: msg });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="billing-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="billing-modal" style={{ width: "min(440px, 100%)" }}>
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <div className="top">
          <h3>Pause your subscription</h3>
          <p>Pause billing for 1, 2, or 3 months. Your credits stay on your account; nothing else changes.</p>
        </div>
        <div className="body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setMonths(n as 1 | 2 | 3)}
                className={"btn-ghost" + (months === n ? " danger" : "")}
                style={{ flexDirection: "column", padding: "16px 8px" }}
              >
                <span style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 500, color: "#ECEAE4" }}>{n}</span>
                <span style={{ fontSize: 11, color: "#5A6268", fontFamily: "var(--mono)", letterSpacing: ".08em", textTransform: "uppercase" }}>
                  month{n > 1 ? "s" : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn-cyan" onClick={submit} disabled={busy}>
            {busy ? "Pausing…" : `Pause for ${months} month${months > 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
