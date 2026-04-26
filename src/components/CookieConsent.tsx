import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { grantAnalyticsConsent } from "@/lib/sentry";

const CONSENT_KEY = "motionmax_cookie_consent";

type ConsentState = "accepted" | "rejected" | null;

function getStoredConsent(): ConsentState {
  try {
    const val = localStorage.getItem(CONSENT_KEY);
    return val === "accepted" || val === "rejected" ? val : null;
  } catch {
    return null;
  }
}

function storeConsent(state: "accepted" | "rejected") {
  try {
    localStorage.setItem(CONSENT_KEY, state);
  } catch { /* ignore */ }
}

/** Returns true if user has accepted analytics cookies */
// eslint-disable-next-line react-refresh/only-export-components
export function hasAnalyticsConsent(): boolean {
  return getStoredConsent() === "accepted";
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // If consent was already granted in a previous session, re-enable analytics
    // integrations immediately without showing the banner again.
    if (getStoredConsent() === "accepted") {
      loadGoogleAnalytics();
      grantAnalyticsConsent();
      return;
    }
    // Only show banner if GA is configured or Sentry DSN is present (either
    // requires explicit consent for analytics-class features).
    const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID;
    const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
    if (!gaId && !sentryDsn) return; // Nothing analytics-related configured
    if (getStoredConsent() !== null) return; // Already answered
    // Small delay so it doesn't flash on page load
    const timer = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const handleAccept = () => {
    storeConsent("accepted");
    setVisible(false);
    // Load GA and enable Sentry Session Replay now that consent is granted.
    loadGoogleAnalytics();
    grantAnalyticsConsent();
  };

  const handleReject = () => {
    storeConsent("rejected");
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie preferences"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-sm z-50 animate-in slide-in-from-bottom-4 fade-in duration-300"
    >
      <div className="rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm p-4 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            <p className="text-sm text-foreground font-medium">Cookie preferences</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We use cookies to analyze site usage and improve your experience.{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy policy</a>
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={handleAccept} className="min-h-[44px] text-xs px-4">
                Accept
              </Button>
              <Button size="sm" variant="ghost" onClick={handleReject} className="min-h-[44px] text-xs px-4 text-muted-foreground">
                Reject
              </Button>
            </div>
          </div>
          <button
            onClick={handleReject}
            aria-label="Close cookie banner"
            className="text-muted-foreground hover:text-foreground p-1.5 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Dynamically load GA4 after consent */
function loadGoogleAnalytics() {
  const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID;
  if (!gaId || typeof window === "undefined") return;
  if (window.gtag) return; // Already loaded

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
  document.head.appendChild(script);
  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) { window.dataLayer!.push(args as unknown as Record<string, unknown>); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", gaId, { send_page_view: true });
}
