/**
 * CookieConsent — granular GDPR-compliant cookie banner.
 *
 * Replaces the previous binary Accept/Reject banner (B-NEW-9 / TONGUE-09 /
 * Comply L-C-05). Offers four categories with toggles where applicable:
 *
 *   • Necessary  — locked-on (auth, security, billing).
 *   • Functional — language preference, theme.
 *   • Analytics  — Sentry Session Replay, GA4.
 *   • Marketing  — pixel-tracking, retargeting (reserved).
 *
 * Three equally-prominent action buttons (Accept all / Reject all / Save
 * preferences) so withdrawal is as easy as consent (GDPR Art. 7(3)).
 *
 * Persistence + version handling lives in `@/lib/cookieConsent`. This
 * component is purely the UI + GA loader + Sentry replay grant.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { grantAnalyticsConsent } from "@/lib/sentry";
import {
  CONSENT_POLICY_VERSION,
  getConsent,
  hasAnswered,
  hasCategoryConsent,
  onConsentChange,
  setConsent,
} from "@/lib/cookieConsent";

// Re-export for legacy callers (useAnalytics scroll tracking) — keeps the
// import path stable while the source of truth moves to cookieConsent.ts.
// eslint-disable-next-line react-refresh/only-export-components
export function hasAnalyticsConsent(): boolean {
  return hasCategoryConsent("analytics");
}

interface CategoryRowProps {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}

function CategoryRow({ id, title, description, checked, disabled, onChange }: CategoryRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-t border-border/40 first:border-t-0">
      <label htmlFor={id} className="flex-1 cursor-pointer select-none">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {title}
          {disabled && (
            <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              Always on
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-muted-foreground leading-relaxed mt-0.5">
          {description}
        </div>
      </label>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={`${title} cookies`}
        disabled={disabled}
        onClick={() => !disabled && onChange?.(!checked)}
        className={[
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors mt-1",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled ? "cursor-not-allowed opacity-60" : "",
          checked ? "bg-[#14C8CC]" : "bg-muted",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [functional, setFunctional] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Open the banner whenever consent is missing, AND re-open if another
  // surface (footer "Cookie preferences" link, Settings "Forget" button)
  // wipes consent at runtime.
  useEffect(() => {
    function syncFromStorage() {
      if (hasAnswered()) {
        // Re-grant in-process integrations on every reload from storage.
        if (hasCategoryConsent("analytics")) {
          loadGoogleAnalytics();
          grantAnalyticsConsent();
        }
        setVisible(false);
        return;
      }
      // No record (or stale version) — show the banner unless there's
      // genuinely nothing analytics-class configured. We still want to
      // show it for functional cookies, but if NEITHER GA nor Sentry are
      // configured the only thing that can change is functional, which
      // we treat as opt-in via the same banner anyway. Net: always show.
      setVisible(true);
    }
    syncFromStorage();
    const unsub = onConsentChange((record) => {
      if (record === null) {
        // revokeConsent() called — re-show the banner.
        setFunctional(false);
        setAnalytics(false);
        setMarketing(false);
        setShowDetails(false);
        setVisible(true);
      } else {
        setFunctional(record.categories.functional);
        setAnalytics(record.categories.analytics);
        setMarketing(record.categories.marketing);
        setVisible(false);
      }
    });
    return unsub;
  }, []);

  // Esc closes the banner only after a save (GDPR: dismissing without an
  // explicit choice is NOT consent). When details panel is open, Esc
  // collapses it instead.
  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showDetails) {
          e.preventDefault();
          setShowDetails(false);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, showDetails]);

  if (!visible) return null;

  const persist = (cats: { functional: boolean; analytics: boolean; marketing: boolean }) => {
    setConsent(cats);
    setVisible(false);
    if (cats.analytics) {
      loadGoogleAnalytics();
      grantAnalyticsConsent();
    }
  };

  const handleAcceptAll = () => persist({ functional: true, analytics: true, marketing: true });
  const handleRejectAll = () => persist({ functional: false, analytics: false, marketing: false });
  const handleSavePreferences = () => persist({ functional, analytics, marketing });

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      aria-describedby="cookie-banner-desc"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-md z-50 animate-in slide-in-from-bottom-4 fade-in duration-300"
    >
      <div className="rounded-xl border border-[#E4C875]/30 bg-background/95 backdrop-blur-sm p-4 shadow-[0_8px_24px_rgba(0,0,0,0.25)]">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2 min-w-0">
            <p id="cookie-banner-title" className="text-sm text-foreground font-medium">
              Cookie preferences
            </p>
            <p id="cookie-banner-desc" className="text-xs text-muted-foreground leading-relaxed">
              We use cookies for essential site features, and (with your permission) for
              analytics. You can change your choices any time from Settings or the
              "Cookie preferences" link in the footer.{" "}
              <a href="/privacy" className="text-[#14C8CC] hover:underline">
                Privacy policy
              </a>
              .
            </p>

            {showDetails && (
              <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-1 mt-2">
                <CategoryRow
                  id="cc-necessary"
                  title="Necessary"
                  description="Auth, security, billing. Required for the site to work."
                  checked
                  disabled
                />
                <CategoryRow
                  id="cc-functional"
                  title="Functional"
                  description="Language preference, theme persistence."
                  checked={functional}
                  onChange={setFunctional}
                />
                <CategoryRow
                  id="cc-analytics"
                  title="Analytics"
                  description="Anonymised usage stats and Sentry session replay on errors."
                  checked={analytics}
                  onChange={setAnalytics}
                />
                <CategoryRow
                  id="cc-marketing"
                  title="Marketing"
                  description="Pixel tracking and retargeting. Reserved — currently unused."
                  checked={marketing}
                  onChange={setMarketing}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={handleAcceptAll}
                className="min-h-[44px] text-xs px-4 bg-[#14C8CC] text-[#0A0D0F] hover:bg-[#0FA6AE]"
              >
                Accept all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRejectAll}
                className="min-h-[44px] text-xs px-4"
              >
                Reject all
              </Button>
              {showDetails ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSavePreferences}
                  className="min-h-[44px] text-xs px-4 border-[#E4C875]/50 text-[#E4C875] hover:bg-[#E4C875]/10"
                >
                  Save preferences
                </Button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDetails(true)}
                  className="min-h-[44px] text-xs px-3 text-[#E4C875] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E4C875] rounded"
                >
                  Customize
                </button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground/70 pt-0.5">
              Policy version {CONSENT_POLICY_VERSION}
            </p>
          </div>

          {/* The X explicitly Rejects all — closing without choosing is not
              treated as consent. Mirrors the Reject button intent so users
              can't be tricked by a quick dismiss. */}
          <button
            onClick={handleRejectAll}
            aria-label="Reject all cookies and close"
            className="text-muted-foreground hover:text-foreground p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14C8CC]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Dynamically load GA4 only after analytics consent. */
function loadGoogleAnalytics() {
  const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID;
  if (!gaId || typeof window === "undefined") return;
  if (window.gtag) return; // Already loaded

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) {
    window.dataLayer!.push(args as unknown as Record<string, unknown>);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", gaId, { send_page_view: true });
}
