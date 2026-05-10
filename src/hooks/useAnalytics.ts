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

/** Safely push an event to gtag or dataLayer.
 *  Gated on the user's analytics-category cookie consent — no events
 *  leave the browser unless the user opted in (B-NEW-9 / GDPR Art. 7). */
function sendEvent(name: string, params?: EventParams) {
  try {
    if (!hasAnalyticsConsent()) {
      // Dev visibility into what we're suppressing for compliance.
      if (import.meta.env.DEV) {
        console.debug("[analytics:skipped — no consent]", name, params);
      }
      return;
    }
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

// ── GA identify / forget ────────────────────────────────────────────────────
// B-NEW-7 (Lens B). Without a `user_id` tied to GA's session, the funnel
// "ad click → anonymous pageview → signup → conversion" cannot be
// stitched: GA only sees an anonymous client_id flip. The fix is to
// call `gtag('config', GA_ID, { user_id: <hash> })` once we know who
// the user is, and clear it on logout.
//
// Privacy: we hash the Supabase user UUID with SHA-256 (browser-native
// SubtleCrypto, no library dependency). GA receives a stable but
// irreversible identifier — sufficient to link sessions across devices
// for one user without leaking the raw UUID into Google's logs.

const GA_ID_META_NAME = "motionmax-ga-id";

function readGaIdFromMeta(): string | null {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector(`meta[name="${GA_ID_META_NAME}"]`);
  if (!meta) return null;
  const value = meta.getAttribute("content");
  if (!value) return null;
  if (!/^G-[A-Z0-9]{6,}$/i.test(value)) return null;
  return value;
}

function readGaId(): string | null {
  // The marketing site exposes the GA ID via a meta tag; the React app
  // build also has it in the Vite env. Prefer the meta tag when present
  // so a Vercel-side rotation flows through without a rebuild.
  const fromMeta = readGaIdFromMeta();
  if (fromMeta) return fromMeta;
  const fromEnv = (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined) ?? "";
  if (!fromEnv) return null;
  if (!/^G-[A-Z0-9]{6,}$/i.test(fromEnv)) return null;
  return fromEnv;
}

async function sha256Hex(input: string): Promise<string> {
  // SubtleCrypto needs a secure context (https or localhost). All
  // production traffic on motionmax.io is HTTPS — the only environment
  // without crypto.subtle is plain-http previews, where we degrade to
  // returning the raw value rather than throwing (analytics must never
  // break the auth flow).
  const subtle =
    typeof window !== "undefined" && window.crypto && window.crypto.subtle
      ? window.crypto.subtle
      : null;
  if (!subtle) return input;
  const data = new TextEncoder().encode(input);
  const buf = await subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Stamp a stable hashed user_id onto the current GA configuration.
 * Called from useAuth on signin and signup. No-ops without analytics
 * consent (so we never push a user_id into a session GA shouldn't be
 * tracking) and no-ops if gtag never loaded.
 */
export async function identifyUser(userId: string): Promise<void> {
  try {
    if (!userId) return;
    if (!hasAnalyticsConsent()) return;
    if (typeof window === "undefined") return;
    if (typeof window.gtag !== "function") return;
    const gaId = readGaId();
    if (!gaId) return;
    const hashed = await sha256Hex(userId);
    window.gtag("config", gaId, { user_id: hashed });
  } catch {
    // analytics is non-critical — never throw out of an auth callback
  }
}

/**
 * Clear the GA user_id on logout. Passing user_id: undefined is the
 * GA-prescribed way to drop the binding so subsequent events on the
 * same client_id are not still attributed to the previous user.
 */
export function clearIdentity(): void {
  try {
    if (typeof window === "undefined") return;
    if (typeof window.gtag !== "function") return;
    const gaId = readGaId();
    if (!gaId) return;
    window.gtag("config", gaId, { user_id: undefined });
  } catch {
    /* swallow */
  }
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
