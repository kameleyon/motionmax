import { useCallback, useEffect, useRef } from "react";
import { hasAnalyticsConsent } from "@/components/CookieConsent";

// ── UTM persistence ──────────────────────────────────────────────────────────
// Capture UTM params on landing and persist in sessionStorage so they survive
// SPA navigation. Passed through to checkout and signup events.

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
const UTM_STORAGE_KEY = "mm_utm";

export function captureUtmParams(): void {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const val = params.get(key);
    if (val) utm[key] = val;
  }
  if (Object.keys(utm).length > 0) {
    sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(utm));
  }
}

export function getStoredUtm(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(UTM_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/* ──────────────────────────────────────────────
 * Lightweight analytics helper.
 *
 * Loads Google Analytics 4 when VITE_GA_MEASUREMENT_ID
 * is set, then fires events via gtag or dataLayer.
 * Falls back to console.debug in dev.
 * ────────────────────────────────────────────── */

// GA4 is now loaded ONLY after cookie consent via CookieConsent.tsx
// This file just sends events if gtag is already present

type EventParams = Record<string, string | number | boolean>;

/** Safely push an event to gtag or dataLayer */
function sendEvent(name: string, params?: EventParams) {
  try {
    // Google Analytics 4 via gtag.js
    if (typeof window !== "undefined" && typeof window.gtag === "function") {
      window.gtag("event", name, params);
      return;
    }
    // Google Tag Manager dataLayer
    if (typeof window !== "undefined" && Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: name, ...params });
      return;
    }
    // Dev fallback
    if (import.meta.env.DEV) {
      console.debug("[analytics]", name, params);
    }
  } catch {
    // Silently swallow — analytics should never break the app
  }
}

/** Track a named event with optional parameters */
export function trackEvent(name: string, params?: EventParams) {
  sendEvent(name, params);
}

/** Hook: track CTA button clicks */
export function useTrackClick(eventName: string, params?: EventParams) {
  return useCallback(() => {
    trackEvent(eventName, params);
  }, [eventName, params]);
}

/** Hook: fires once when the element scrolls into view */
export function useTrackImpression(
  eventName: string,
  ref: React.RefObject<HTMLElement | null>,
  params?: EventParams,
) {
  const fired = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || fired.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !fired.current) {
          fired.current = true;
          trackEvent(eventName, params);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [eventName, params, ref]);
}

/** Hook: track maximum scroll depth on the page (25 / 50 / 75 / 100 %) */
export function useScrollDepthTracker() {
  const milestones = useRef(new Set<number>());

  useEffect(() => {
    function onScroll() {
      if (!hasAnalyticsConsent()) return;
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;

      const pct = Math.round((scrollTop / docHeight) * 100);
      const thresholds = [25, 50, 75, 100];

      for (const t of thresholds) {
        if (pct >= t && !milestones.current.has(t)) {
          milestones.current.add(t);
          trackEvent("scroll_depth", { depth_percent: t });
        }
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}
