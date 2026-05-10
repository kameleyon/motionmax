/**
 * Marketing analytics loader — B-NEW-10 / TONGUE-10.
 *
 * The marketing site at motionmax.io previously had ZERO consent gate:
 * any tracker added in BaseLayout would fire on first paint, before EU
 * visitors had a chance to consent. This module is the single entry
 * point for tracker init on the marketing site, and it ALWAYS gates on
 * `hasCategoryConsent('analytics')` from cookieConsent.js.
 *
 * Today we wire GA4 only. Add additional vendors here (Facebook Pixel,
 * LinkedIn Insight, etc.) under the same gate — never inline them in a
 * page or layout.
 *
 * GA measurement ID is read from a `<meta name="motionmax-ga-id">` tag
 * emitted by BaseLayout.astro. We use the meta-tag indirection rather
 * than `import.meta.env.PUBLIC_GA_MEASUREMENT_ID` so the marketing
 * Astro build doesn't have to be re-built to rotate the GA ID — Vercel
 * env vars flow through the Astro frontmatter at render time.
 */

import { hasCategoryConsent, onConsentChange } from "./cookieConsent.js";

// B-NEW-7 (Lens B) — UTMs captured on landing live in the same shared
// store the React app reads. Importing the storage keys directly keeps
// the dependency graph minimal — utmCapture.js owns writes, this file
// only reads.
const UTM_LS_KEY = "motionmax_utm";
const UTM_COOKIE_NAME = "motionmax_utm";

function readUtmCookie() {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const c of cookies) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    if (c.slice(0, eq) === UTM_COOKIE_NAME) {
      try {
        return decodeURIComponent(c.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readUtms() {
  // localStorage first (same-origin, fastest), cookie fallback so a
  // cross-page reload that wiped LS still surfaces attribution.
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem(UTM_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    }
  } catch {
    /* private mode — fall through */
  }
  const cookieRaw = readUtmCookie();
  if (cookieRaw) {
    try {
      return JSON.parse(cookieRaw);
    } catch {
      return null;
    }
  }
  return null;
}

function utmsAsParams() {
  const u = readUtms();
  if (!u) return {};
  const out = {};
  if (u.source)   out.utm_source   = u.source;
  if (u.medium)   out.utm_medium   = u.medium;
  if (u.campaign) out.utm_campaign = u.campaign;
  if (u.term)     out.utm_term     = u.term;
  if (u.content)  out.utm_content  = u.content;
  if (u.gclid)    out.gclid        = u.gclid;
  if (u.fbclid)   out.fbclid       = u.fbclid;
  return out;
}

function trackMarketingEvent(name, params) {
  if (!hasCategoryConsent("analytics")) return;
  if (typeof window === "undefined") return;
  if (typeof window.gtag !== "function") {
    if (Array.isArray(window.dataLayer)) {
      window.dataLayer.push({ event: name, ...(params || {}) });
    }
    return;
  }
  window.gtag("event", name, params || {});
}

function readGaId() {
  if (typeof document === "undefined") return null;
  const meta = document.querySelector('meta[name="motionmax-ga-id"]');
  if (!meta) return null;
  const value = meta.getAttribute("content");
  if (!value) return null;
  // Reject the unreplaced placeholder so we don't ping GA with literal
  // "G-XXXXXXXXXX" from .env.example.
  if (!/^G-[A-Z0-9]{6,}$/i.test(value)) return null;
  return value;
}

let gaLoaded = false;

function loadGoogleAnalytics() {
  if (gaLoaded) return;
  if (typeof window === "undefined") return;
  if (window.gtag) {
    gaLoaded = true;
    return;
  }
  const gaId = readGaId();
  if (!gaId) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", gaId, { send_page_view: true });
  gaLoaded = true;
}

// B-NEW-7 (Lens B) — pricing-section impression observer. Fires
// `pricing_viewed` once per page load when the section enters the
// viewport. Threshold 0.3 matches the React-side useTrackImpression so
// dashboards can compare apples-to-apples between marketing and app
// analytics. Idempotent: the observer disconnects after the first
// firing so a user who scrolls back doesn't double-count.
function watchPricingSection() {
  if (typeof window === "undefined") return;
  if (typeof IntersectionObserver === "undefined") return;
  const section = document.getElementById("pricing");
  if (!section) return;
  let fired = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !fired) {
          fired = true;
          trackMarketingEvent("pricing_viewed", utmsAsParams());
          observer.disconnect();
          return;
        }
      }
    },
    { threshold: 0.3 },
  );
  observer.observe(section);
}

// B-NEW-7 (Lens B) — delegated click handler for marketing CTAs. Any
// link or button whose visible label matches the CTA pattern (Get
// started / Sign up / Continue / Start free) emits `cta_clicked` with
// the button text + href so we can rank which button copy converts.
const CTA_LABEL_PATTERN = /\b(get\s+started|sign\s*up|continue|start\s+(free|now)|try\s+free)\b/i;

function attachCtaListener() {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Walk up to the nearest <a> or <button> so a click on inner
      // <span>/<svg> still resolves to the actionable element.
      const el = target.closest("a, button");
      if (!el) return;
      const label = (el.textContent || "").trim();
      if (!label) return;
      if (!CTA_LABEL_PATTERN.test(label)) return;
      const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
      trackMarketingEvent("cta_clicked", {
        label: label.slice(0, 80),
        href,
        ...utmsAsParams(),
      });
    },
    { capture: true, passive: true },
  );
}

export function initMarketingAnalytics() {
  if (hasCategoryConsent("analytics")) {
    loadGoogleAnalytics();
  }
  // Re-check whenever consent changes — a user who initially rejects can
  // come back via the footer link, accept analytics, and we'll start
  // tracking from that point forward (no historical replay).
  onConsentChange((record) => {
    if (record && record.categories && record.categories.analytics) {
      loadGoogleAnalytics();
    }
    // We deliberately do NOT tear GA down on revoke: GA4 honours the
    // current `consent` signal, but the script tag staying in the DOM
    // means a hot-reload of consent doesn't require a page reload to
    // start tracking again. Future hardening: emit gtag('consent',
    // 'update', { analytics_storage: 'denied' }) on revoke.
  });

  // Wire CTA + pricing-section observers regardless of consent state —
  // the events themselves are gated inside trackMarketingEvent. This
  // way a user who accepts analytics mid-session immediately gets
  // funnel events on subsequent interactions without a page reload.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        watchPricingSection();
        attachCtaListener();
      });
    } else {
      watchPricingSection();
      attachCtaListener();
    }
  }
}
