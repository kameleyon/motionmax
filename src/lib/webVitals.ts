/**
 * Lightweight Web Vitals reporter.
 *
 * §5 PERF — the audit flagged "no Web Vitals reporting" so we have no
 * field data to gate Lighthouse-CI against. Rather than pull in the
 * `web-vitals` npm package (ships ~3 KB gz + first-party API surface),
 * this module subscribes to the same browser-native observers it would
 * use (PerformanceObserver for LCP / CLS / INP, navigation timing for
 * TTFB) and pushes the metrics through the existing `trackEvent`
 * pipeline so they land in GA alongside funnel events.
 *
 * Metrics:
 *   - LCP : largest-contentful-paint (capture last value before unload)
 *   - CLS : layout-shift sum across the session, reported on hide
 *   - INP : largest event-input duration over the session
 *   - TTFB: navigation responseStart - requestStart
 *
 * Buckets follow Google's 2026 thresholds. Values are rounded to keep
 * GA's parameter cardinality manageable.
 */

import { trackEvent } from "@/hooks/useAnalytics";

type VitalName = "LCP" | "CLS" | "INP" | "TTFB";

interface VitalSample {
  name: VitalName;
  value: number;
  rating: "good" | "needs-improvement" | "poor";
}

const THRESHOLDS: Record<VitalName, [number, number]> = {
  LCP:  [2500, 4000],
  CLS:  [0.1, 0.25],
  INP:  [200, 500],
  TTFB: [800, 1800],
};

function rate(name: VitalName, value: number): VitalSample["rating"] {
  const [good, poor] = THRESHOLDS[name];
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

function report(sample: VitalSample): void {
  trackEvent("web_vital", {
    metric_name: sample.name,
    metric_value: sample.value,
    metric_rating: sample.rating,
  });
}

function safeObserver(
  type: string,
  cb: (entries: PerformanceEntry[]) => void,
  buffered = true,
): PerformanceObserver | null {
  if (typeof PerformanceObserver === "undefined") return null;
  try {
    const po = new PerformanceObserver((list) => cb(list.getEntries()));
    po.observe({ type, buffered } as PerformanceObserverInit);
    return po;
  } catch {
    return null;
  }
}

export function startWebVitalsReporting(): void {
  if (typeof window === "undefined") return;

  // ── LCP ────────────────────────────────────────────────────────
  let lastLcp = 0;
  safeObserver("largest-contentful-paint", (entries) => {
    const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number };
    if (last) lastLcp = Math.round(last.startTime);
  });

  // ── CLS ────────────────────────────────────────────────────────
  let clsValue = 0;
  safeObserver("layout-shift", (entries) => {
    for (const e of entries as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
      if (!e.hadRecentInput) clsValue += e.value;
    }
  });

  // ── INP (largest event-timing duration) ────────────────────────
  let largestInp = 0;
  safeObserver("event", (entries) => {
    for (const e of entries as Array<PerformanceEntry & { duration: number }>) {
      if (e.duration > largestInp) largestInp = Math.round(e.duration);
    }
  });

  // ── TTFB (one-shot from navigation timing) ─────────────────────
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) {
      const ttfb = Math.max(0, Math.round(nav.responseStart - nav.requestStart));
      report({ name: "TTFB", value: ttfb, rating: rate("TTFB", ttfb) });
    }
  } catch {
    // ignore — navigation timing not supported
  }

  // Flush LCP/CLS/INP on visibility change so we capture the final
  // values before the user navigates away. Use `pagehide` as the
  // belt-and-suspenders fallback for browsers that don't dispatch
  // `visibilitychange` reliably on tab close (older Safari).
  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    if (lastLcp > 0)   report({ name: "LCP", value: lastLcp,    rating: rate("LCP",  lastLcp) });
    if (clsValue >= 0) report({ name: "CLS", value: Math.round(clsValue * 1000) / 1000, rating: rate("CLS", clsValue) });
    if (largestInp > 0) report({ name: "INP", value: largestInp, rating: rate("INP",  largestInp) });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}
