// FTC Click-to-Cancel (16 CFR Part 425) rule, effective 2026-05-14, requires
// that the cancellation path be "at least as easy as" the sign-up path.
// Audit context: C-11-6 / Comply L-C-09. The Settings + Billing Overview
// entry points open this modal directly (one click). The user can then
// confirm cancellation with a single second click on "Cancel subscription"
// — the reason dropdown is OPTIONAL and never gates the action. The
// retention discount and pause options are presented on the SAME screen
// (not behind interstitials) so the user never has to dismiss anything
// to complete the cancel. Total clicks Settings → confirmation: 2.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { callCancelWithReason, callPauseSubscription } from "./_shared/billingApi";
import { num } from "./_shared/format";

const REASONS = [
  "Too expensive",
  "Not using it enough",
  "Missing a feature",
  "Found another tool",
  "Just trying it out",
  "Other",
];

type Phase = "choose" | "confirmed";

export function CancelRetentionModal({
  open,
  onClose,
  videosRendered,
  unusedCredits,
  periodEnd,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  videosRendered: number;
  unusedCredits: number;
  /** ISO timestamp the current paid period ends — used for the post-cancel
   * confirmation copy. If undefined we fall back to a generic message. */
  periodEnd?: string | null;
  onChanged: () => void;
}) {
  const { session } = useAuth();
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState<"" | "keep" | "cancel" | "pause">("");
  const [phase, setPhase] = useState<Phase>("choose");
  // C-11-6: pause months selector is part of the same screen so the
  // user never has to dismiss the cancel modal to find Pause. This
  // keeps the FTC "at least as easy as signup" gate satisfied — every
  // retention option is reachable without leaving the flow.
  const [pauseMonths, setPauseMonths] = useState<1 | 2 | 3>(1);
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset state every time the modal re-opens so a returning user
  // doesn't see stale "confirmed" copy from a previous session.
  useEffect(() => {
    if (open) {
      setReason("");
      setBusy("");
      setPhase("choose");
      setPauseMonths(1);
      setConfirmedMessage(null);
    }
  }, [open]);

  if (!open) return null;

  function fmtEndDate(iso: string | null | undefined): string {
    if (!iso) return "the end of your current billing period";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric", month: "long", day: "numeric",
      });
    } catch {
      return "the end of your current billing period";
    }
  }

  async function handleCancel() {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    setBusy("cancel");
    try {
      // Reason is optional per FTC click-to-cancel — pass null when empty.
      const resp = await callCancelWithReason(
        session.access_token,
        reason.trim() || null,
        /* keepWithOffer */ false,
      );
      const endIso =
        (resp && typeof resp === "object" && "current_period_end" in resp
          ? (resp as { current_period_end?: string | null }).current_period_end
          : null) ?? periodEnd ?? null;
      setConfirmedMessage(
        `Your subscription will end on ${fmtEndDate(endIso)}. ` +
        `You'll keep full access until then. ` +
        `If you change your mind, you can re-subscribe any time before that date.`,
      );
      setPhase("confirmed");
      toast.success("Subscription cancelled.");
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Could not cancel subscription", { description: msg });
    } finally {
      setBusy("");
    }
  }

  async function handleKeepWithOffer() {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    setBusy("keep");
    try {
      const resp = await callCancelWithReason(session.access_token, reason.trim() || null, true);
      if (resp?.kept_with_offer) {
        toast.success("Retention discount applied — you saved 50% for the next 3 months.");
      } else {
        toast("Kept on plan.");
      }
      onChanged();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Could not apply offer", { description: msg });
    } finally {
      setBusy("");
    }
  }

  async function handlePause() {
    if (!session?.access_token) { toast.error("Please sign in"); return; }
    setBusy("pause");
    try {
      await callPauseSubscription(session.access_token, pauseMonths);
      toast.success(`Subscription paused for ${pauseMonths} month${pauseMonths > 1 ? "s" : ""}.`, {
        description: "Billing stops now. Your credits remain on your account.",
      });
      onChanged();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Could not pause", { description: msg });
    } finally {
      setBusy("");
    }
  }

  return createPortal(
    <div
      className="billing-modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="billing-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Cancel subscription"
        style={{ width: "min(560px, 100%)" }}
      >
        <button type="button" className="x" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {phase === "confirmed" && confirmedMessage ? (
          <>
            <div className="top">
              <h3>Subscription cancelled</h3>
              <p>{confirmedMessage}</p>
            </div>
            <div className="foot">
              <button
                type="button"
                className="btn-cyan"
                onClick={onClose}
                autoFocus
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="top">
              <h3>Cancel your subscription</h3>
              <p>
                You've rendered <b style={{ color: "#ECEAE4" }}>{num(videosRendered)} videos</b> on your plan.
                Cancelling now means losing premium features and{" "}
                <b style={{ color: "#ECEAE4" }}>{num(unusedCredits)} unused credits</b>.
                Below are all your options on one screen — no extra steps either way.
              </p>
            </div>
            <div className="body">
              {/* Retention offer card — same row as cancel, not a gate. */}
              <div className="offer">
                <div className="ico">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <path d="M12 2L4 6v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V6z" />
                    <path d="M9 12l2 2 4-4" />
                  </svg>
                </div>
                <div>
                  <p className="t">Optional: take 50% off for the next 3 months.</p>
                  <p className="d">Stay on your plan at half-price. Code RETAIN50. No pressure — skip if not interested.</p>
                </div>
              </div>

              {/* Pause option — same row. */}
              <div
                style={{
                  marginTop: 12,
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "12px 14px",
                  background: "var(--panel-2)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ color: "#ECEAE4", fontSize: 14, fontWeight: 500 }}>
                      Or pause your subscription instead
                    </div>
                    <div style={{ color: "#5A6268", fontSize: 12, marginTop: 2 }}>
                      Billing stops; credits stay. Resume any time.
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[1, 2, 3].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setPauseMonths(n as 1 | 2 | 3)}
                        className={"btn-ghost" + (pauseMonths === n ? " danger" : "")}
                        style={{ minWidth: 44, padding: "6px 10px", fontSize: 12 }}
                        aria-label={`Pause for ${n} month${n > 1 ? "s" : ""}`}
                      >
                        {n}m
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={handlePause}
                      disabled={busy !== ""}
                      style={{ padding: "6px 12px", fontSize: 12 }}
                    >
                      {busy === "pause" ? "Pausing…" : `Pause ${pauseMonths}m`}
                    </button>
                  </div>
                </div>
              </div>

              {/* OPTIONAL reason — never gates the cancel button per FTC rule. */}
              <div style={{
                fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".12em",
                textTransform: "uppercase", color: "#5A6268", margin: "16px 0 8px",
              }}>
                Why are you leaving? <span style={{ textTransform: "none", letterSpacing: 0 }}>(optional)</span>
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
                className="btn-ghost danger"
                disabled={busy !== ""}
                onClick={handleCancel}
                style={{ opacity: busy === "cancel" ? 0.6 : 1 }}
                aria-label="Cancel subscription"
              >
                {busy === "cancel" ? "Cancelling…" : "Cancel subscription"}
              </button>
              <button
                type="button"
                className="btn-cyan"
                disabled={busy !== ""}
                onClick={handleKeepWithOffer}
                aria-label="Keep subscription with 50% off offer"
              >
                {busy === "keep" ? "Applying…" : "Keep subscription (50% off)"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
