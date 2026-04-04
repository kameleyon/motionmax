import { useCallback, useEffect, useRef } from "react";

/* ──────────────────────────────────────────────
 * Lightweight analytics helper.
 *
 * Loads Google Analytics 4 when VITE_GA_MEASUREMENT_ID
 * is set, then fires events via gtag or dataLayer.
 * Falls back to console.debug in dev.
 * ────────────────────────────────────────────── */

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID ?? "";

// Self-executing: load GA4 script once on import
if (GA_ID && typeof window !== "undefined") {
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);
  (window as any).dataLayer = (window as any).dataLayer || [];
  function gtag(...args: any[]) { (window as any).dataLayer.push(arguments); }
  (window as any).gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID, { send_page_view: true });
}

type EventParams = Record<string, string | number | boolean>;

/** Safely push an event to gtag or dataLayer */
function sendEvent(name: string, params?: EventParams) {
  try {
    // Google Analytics 4 via gtag.js
    if (typeof window !== "undefined" && typeof (window as any).gtag === "function") {
      (window as any).gtag("event", name, params);
      return;
    }
    // Google Tag Manager dataLayer
    if (typeof window !== "undefined" && Array.isArray((window as any).dataLayer)) {
      (window as any).dataLayer.push({ event: name, ...params });
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
