/**
 * UTM capture + cross-subdomain handoff — B-NEW-7 (Lens B).
 *
 * Problem: a paid-search visitor lands on motionmax.io with
 *   ?utm_source=google&utm_campaign=launch
 * clicks "Sign up", and the React app at app.motionmax.io has NO IDEA
 * which campaign drove the signup. UTMs were dying at the subdomain
 * boundary because the marketing site never persisted them, and even
 * if it had, localStorage is per-origin (motionmax.io ≠ app.motionmax.io).
 *
 * Fix:
 *   1. Parse utm_* + gclid + fbclid from window.location.search.
 *   2. Persist to BOTH:
 *        - localStorage["motionmax_utm"]  (fast read on the same origin)
 *        - cookie "motionmax_utm" with Domain=.motionmax.io  (visible to
 *          app.motionmax.io on the next hop — same trick as the consent
 *          cookie in cookieConsent.js)
 *   3. Idempotent first-touch attribution: if a record exists with a
 *      captured_at within 30 days, do NOT overwrite. First-touch is the
 *      standard model for SaaS top-of-funnel attribution because the
 *      original ad click is what created the lead — later organic visits
 *      from the same browser shouldn't steal credit. Last-touch (always
 *      overwrite) is a follow-up if the marketing team prefers it; it
 *      would be a one-line flip below.
 *   4. Gate everything on `hasCategoryConsent('analytics')`. UTMs are
 *      attribution data — under GDPR they live in the analytics bucket.
 *
 * Why this lives in /scripts and not in BaseLayout.astro:
 *   The site CSP (vercel.json) is `script-src 'self'` — no inline
 *   scripts, no nonce. Astro emits this file as a hashed /_astro/*.js
 *   served same-origin, satisfying CSP. The layout just <script>-tag-
 *   imports it.
 */

import { hasCategoryConsent } from "./cookieConsent.js";

const STORAGE_KEY = "motionmax_utm";
const COOKIE_NAME = "motionmax_utm";
const MAX_AGE_DAYS = 30;
const MAX_AGE_SECONDS = MAX_AGE_DAYS * 24 * 60 * 60;

/**
 * Resolve the parent domain we should pin the shared cookie to. Mirrors
 * the logic in cookieConsent.js so the two cookies land on the same
 * .motionmax.io scope and survive the marketing→app subdomain hop.
 */
function resolveCookieDomain() {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (!host) return null;
  if (host === "localhost" || host === "127.0.0.1") return null;
  if (host.endsWith(".local")) return null;
  if (host === "motionmax.io" || host.endsWith(".motionmax.io")) {
    return ".motionmax.io";
  }
  return null;
}

function safeLocalStorage() {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readCookie(name) {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const c of cookies) {
    const eq = c.indexOf("=");
    if (eq < 0) continue;
    const k = c.slice(0, eq);
    if (k === name) {
      try {
        return decodeURIComponent(c.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeCookie(name, value, maxAgeSeconds) {
  if (typeof document === "undefined") return;
  const domain = resolveCookieDomain();
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push("Secure");
  document.cookie = parts.join("; ");
}

function readExistingRecord() {
  // Prefer localStorage (faster), fall back to cookie. Returns null on
  // any parse error so we treat a malformed blob as "no record" — the
  // next valid landing will overwrite it cleanly.
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch {
      /* fall through */
    }
  }
  const cookieRaw = readCookie(COOKIE_NAME);
  if (cookieRaw) {
    try {
      const parsed = JSON.parse(cookieRaw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function isFresh(record) {
  if (!record || !record.captured_at) return false;
  const t = Date.parse(record.captured_at);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs >= 0 && ageMs < MAX_AGE_SECONDS * 1000;
}

/**
 * Parse UTM + click-id params from the current URL. Returns null if
 * NONE are present so callers can short-circuit (don't write empty
 * records, don't dispatch events).
 */
function parseUtmsFromUrl() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const source  = params.get("utm_source")   || null;
  const medium  = params.get("utm_medium")   || null;
  const campaign = params.get("utm_campaign") || null;
  const term    = params.get("utm_term")     || null;
  const content = params.get("utm_content")  || null;
  const gclid   = params.get("gclid")        || null;
  const fbclid  = params.get("fbclid")       || null;

  if (!source && !medium && !campaign && !term && !content && !gclid && !fbclid) {
    return null;
  }

  return {
    source,
    medium,
    campaign,
    term,
    content,
    gclid,
    fbclid,
    captured_at: new Date().toISOString(),
    landing_url: window.location.href,
  };
}

/**
 * Idempotently capture UTMs from the URL. Wires the "first-touch
 * attribution wins" rule: a fresh existing record (within 30 days) is
 * preserved. Returns the persisted record (existing or new), or null
 * when nothing was captured and nothing pre-existed.
 *
 * NOTE: a future "last-touch" mode is a one-line change — drop the
 * `isFresh(existing)` guard and always overwrite. We deliberately ship
 * first-touch by default because it credits the original acquisition
 * channel rather than the user's most recent return visit.
 */
export function captureUtms() {
  if (typeof window === "undefined") return null;

  // Treat UTMs as analytics data: do not write attribution storage
  // before the user has consented to analytics.
  if (!hasCategoryConsent("analytics")) return null;

  const fresh = parseUtmsFromUrl();
  const existing = readExistingRecord();

  // First-touch: existing fresh record wins.
  if (existing && isFresh(existing)) {
    return existing;
  }

  // Nothing on the URL and no fresh prior record — nothing to do.
  if (!fresh) return existing || null;

  const serialised = JSON.stringify(fresh);
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, serialised);
    } catch {
      /* private mode / quota — cookie still works */
    }
  }
  writeCookie(COOKIE_NAME, serialised, MAX_AGE_SECONDS);

  return fresh;
}

/**
 * Convenience entry-point for the BaseLayout mount script. Runs
 * capture on DOM ready + every consent change so a user who initially
 * declines analytics, then accepts via the footer link on the same
 * pageview, still gets their UTMs persisted.
 */
export function initUtmCapture() {
  if (typeof window === "undefined") return;
  // Run immediately so SPA-style internal links don't lose the
  // landing URL search params before we read them.
  captureUtms();

  // Re-run when consent changes — cheap, idempotent, and the only way
  // to backfill a session where the user accepted after the first
  // capture attempt was gated.
  window.addEventListener("motionmax:consent-changed", () => {
    captureUtms();
  });
}
