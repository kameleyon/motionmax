/**
 * MotionMax v2.0 Announcement Modal.
 *
 * Behaviour: when an authenticated user lands on any in-app surface,
 * we read profiles.dismissed_v2_announcement_at. If NULL, the modal
 * shows. The user can:
 *   - Click "Take me in" without checking the box → closes for this
 *     session only; modal returns on the next login. (Tracked via a
 *     short-lived sessionStorage key so it doesn't immediately re-open
 *     on a route change within the same tab.)
 *   - Check "Don't show this again" + close (X / "Take me in" / Esc) →
 *     calls RPC dismiss_v2_announcement() which timestamps the column;
 *     the user never sees it again on any device.
 *
 * Design ported verbatim from MotionMax Dashboard standalone bundle
 * (`mm-ann-overlay` / `mm-ann` styles + 6-feature highlight list).
 *
 * Mount globally inside <BrowserRouter> next to SubscriptionRenewalModal.
 * Skips rendering when:
 *   - User is unauthenticated
 *   - Profile already has dismissed_v2_announcement_at set
 *   - Current route is /auth, /, /share/* (public surfaces)
 *   - sessionStorage flag is set (closed-this-session)
 */

import { useEffect, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import "./v2-announcement.css";

const SESSION_KEY = "mm_v2_announce_session_dismissed";

function shouldGateRoute(pathname: string): boolean {
  // Public/onboarding routes where the modal would feel out of place.
  if (pathname === "/" || pathname === "/auth") return true;
  if (pathname.startsWith("/share/")) return true;
  if (pathname.startsWith("/legal/")) return true;
  return false;
}

export function V2AnnouncementModal() {
  const { user } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [closing, setClosing] = useState(false);

  // Read the dismissal timestamp once per user session. staleTime is
  // long because this only flips one direction (NULL → set).
  const { data: profile } = useQuery({
    queryKey: ["profile", "v2-announcement", user?.id],
    enabled: !!user?.id,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .select("dismissed_v2_announcement_at" as any)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { dismissed_v2_announcement_at: string | null } | null;
    },
  });

  // Decide whether the modal should open. Re-evaluate on auth, profile,
  // and route changes so a fresh login on the same tab triggers it.
  useEffect(() => {
    if (!user?.id) { setOpen(false); return; }
    if (shouldGateRoute(location.pathname)) { setOpen(false); return; }
    if (profile === undefined) return; // still loading
    if (profile?.dismissed_v2_announcement_at) { setOpen(false); return; }
    // Honour session-only dismissals (clicked "Take me in" without
    // checking the box — modal won't bother them again until they log
    // out and back in, but the per-user timestamp stays NULL so future
    // logins still get the welcome).
    let sessionDismissed = false;
    try { sessionDismissed = sessionStorage.getItem(SESSION_KEY) === "1"; } catch { /* private mode */ }
    if (sessionDismissed) { setOpen(false); return; }
    // Small delay matches the original 500ms drama from the design.
    const t = setTimeout(() => setOpen(true), 500);
    return () => clearTimeout(t);
  }, [user?.id, profile, location.pathname]);

  // Close handler. If "Don't show again" is checked, persist via RPC
  // before unmounting. Always set the per-session flag so the modal
  // doesn't re-open on the very next route change.
  const close = useCallback(async () => {
    if (closing) return;
    setClosing(true);

    if (dontShowAgain && user?.id) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase.rpc as any)("dismiss_v2_announcement");
        if (!error) {
          // Refresh the cache so any other consumer sees the new value
          // without a round-trip.
          queryClient.setQueryData(
            ["profile", "v2-announcement", user.id],
            { dismissed_v2_announcement_at: new Date().toISOString() },
          );
        }
      } catch { /* swallow — at worst the modal reappears next load */ }
    }
    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* private mode */ }

    // Match the design's 250ms exit transition before unmounting.
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 280);
  }, [closing, dontShowAgain, user?.id, queryClient]);

  // ESC closes (matches the design's escClose handler).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Body-scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`mm-ann-overlay ${closing ? "" : "on"}`}
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      aria-hidden={!open}
    >
      <div
        className="mm-ann"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mmAnnTitle"
      >
        <button
          className="mm-ann-x"
          aria-label="Close announcement"
          onClick={close}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Left stage — v2.0 number with cyan/gold radial glows */}
        <div className="mm-ann-stage" aria-hidden="true">
          <div className="mm-ann-grid" />
          <div className="mm-ann-glow" />
          <div className="mm-ann-version">
            <span className="mm-ann-tag">RELEASE · MAY 2026</span>
            <div className="mm-ann-num"><span>v</span>2<i>.</i>0</div>
            <span className="mm-ann-pulse" />
          </div>
        </div>

        {/* Right body — eyebrow, title, lede, feature list, CTA, opt-out */}
        <div className="mm-ann-body">
          <div className="mm-ann-eyebrow"><span className="d" />Announcing</div>
          <h2 id="mmAnnTitle" className="mm-ann-title">
            MotionMax <em>v2.0</em><br />is here.
          </h2>
          <p className="mm-ann-lede">
            A new Studio. A new Lab. A new way to ship video at the speed you think.
          </p>

          <ul className="mm-ann-list">
            <li>
              <div className="mm-ann-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </div>
              <div>
                <h4>A redesigned Dashboard</h4>
                <p>Calmer, faster, more focused. One canvas for every project, idea and draft.</p>
              </div>
            </li>
            <li>
              <div className="mm-ann-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M4 17l6-6 4 4 6-9" />
                  <path d="M4 21h16" />
                </svg>
              </div>
              <div>
                <h4>Full editor control</h4>
                <p>Frame-precise timing, captions, voice and music — every layer at your fingertips.</p>
              </div>
            </li>
            <li>
              <div className="mm-ann-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M12 3v18" />
                  <path d="M8 7v10" />
                  <path d="M4 10v4" />
                  <path d="M16 7v10" />
                  <path d="M20 10v4" />
                </svg>
              </div>
              <div>
                <h4>30+ natural voices, cloning &amp; lip&#8209;sync</h4>
                <p>
                  Studio-grade narration in <b>13 languages</b>. Clone your own voice in under
                  a minute, then sync it perfectly to any character on screen.
                </p>
              </div>
            </li>
            <li>
              <div className="mm-ann-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M4 7h16" />
                  <path d="M4 12h10" />
                  <path d="M4 17h16" />
                  <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
                </svg>
              </div>
              <div>
                <h4>15+ caption styles</h4>
                <p>From clean broadcast lower-thirds to bouncy social karaoke — word-by-word highlight, emoji bursts, kinetic type, all editable per project.</p>
              </div>
            </li>
            <li>
              <div className="mm-ann-ico">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <rect x="6" y="4" width="12" height="5" rx="1" />
                  <circle cx="9" cy="4" r="1" />
                  <circle cx="15" cy="4" r="1" />
                  <rect x="4" y="9" width="16" height="11" rx="1" />
                  <path d="M9 13h.01M15 13h.01" />
                  <path d="M10 17c1 .8 3 .8 4 0" />
                </svg>
              </div>
              <div>
                <h4>New design styles — LEGO, Barbie, Cardboard &amp; more</h4>
                <p>Render any scene in playful aesthetics: brick-built worlds, plastic pop, paper-craft cutouts, claymation, pixel-art and a dozen other looks.</p>
              </div>
            </li>
            <li>
              <div className="mm-ann-ico mm-ann-ico-gold">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M12 2v4" />
                  <path d="M12 18v4" />
                  <path d="M4.93 4.93l2.83 2.83" />
                  <path d="M16.24 16.24l2.83 2.83" />
                  <path d="M2 12h4" />
                  <path d="M18 12h4" />
                  <path d="M4.93 19.07l2.83-2.83" />
                  <path d="M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div>
                <h4>AutoPost Lab <span className="mm-ann-new">NEW</span></h4>
                <p>Schedule and publish via email or app — automate your library and let MotionMax do the busywork. Native social platform integrations soon.</p>
              </div>
            </li>
          </ul>

          <div className="mm-ann-cta">
            <button type="button" className="mm-ann-btn primary" onClick={close}>
              Take me in
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
          <div className="mm-ann-foot">
            <label>
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
              />
              {" "}Don't show this again
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

export default V2AnnouncementModal;
