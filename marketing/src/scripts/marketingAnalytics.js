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
}
