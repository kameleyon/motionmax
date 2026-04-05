import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

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
export function hasAnalyticsConsent(): boolean {
  return getStoredConsent() === "accepted";
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only show if no stored consent and GA is configured
    const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID;
    if (!gaId) return; // No GA configured, no banner needed
    if (getStoredConsent() !== null) return; // Already answered
    // Small delay so it doesn't flash on page load
    const timer = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const handleAccept = () => {
    storeConsent("accepted");
    setVisible(false);
    // Load GA now
    loadGoogleAnalytics();
  };

  const handleReject = () => {
    storeConsent("rejected");
    setVisible(false);
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:max-w-sm z-50 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-2">
            <p className="text-sm text-foreground font-medium">Cookie preferences</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              We use cookies to analyze site usage and improve your experience.{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy policy</a>
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={handleAccept} className="h-7 text-xs px-3">
                Accept
              </Button>
              <Button size="sm" variant="ghost" onClick={handleReject} className="h-7 text-xs px-3 text-muted-foreground">
                Reject
              </Button>
            </div>
          </div>
          <button onClick={handleReject} className="text-muted-foreground hover:text-foreground p-0.5">
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
  if ((window as any).gtag) return; // Already loaded

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
  document.head.appendChild(script);
  (window as any).dataLayer = (window as any).dataLayer || [];
  function gtag(...args: any[]) { (window as any).dataLayer.push(arguments); }
  (window as any).gtag = gtag;
  gtag("js", new Date());
  gtag("config", gaId, { send_page_view: true });
}
