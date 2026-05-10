/**
 * Cookie consent registry — Astro / marketing site (B-NEW-10 / TONGUE-10).
 *
 * Vanilla JS twin of `src/lib/cookieConsent.ts` (B-NEW-9, React app).
 * The two files MUST stay shape-identical:
 *
 *   • Same CONSENT_POLICY_VERSION (bump in lockstep when categorisation
 *     changes — otherwise the two halves of the site disagree on whether
 *     the user has answered).
 *   • Same STORAGE_KEY ("motionmax_cookie_consent_v2") so a user who
 *     answers on the marketing site does NOT see the banner again on the
 *     app, and vice versa.
 *   • Same JSON shape on disk: { version, timestamp, categories: {
 *     necessary, functional, analytics, marketing } }.
 *
 * ── Why a domain-scoped cookie in addition to localStorage ────────────
 * The marketing site is served from motionmax.io, the React app from
 * app.motionmax.io. localStorage is per-origin, so a record written on
 * motionmax.io is INVISIBLE to app.motionmax.io. To carry consent across
 * the subdomain hop (so users don't see the banner twice), we mirror the
 * record into a cookie scoped to `.motionmax.io`. The React app's
 * `cookieConsent.ts` reads the cookie on first paint if localStorage is
 * empty and rehydrates it.
 *
 * In dev (localhost / *.local) the cookie domain attribute is omitted —
 * cookies fall back to host-only and only localStorage shares state.
 *
 * ── Why pure JS, not TS ───────────────────────────────────────────────
 * The Astro site is loaded by every marketing page including the legal
 * pages. The CSP at `script-src 'self'` blocks any inline script, so we
 * import this file as an external module from CookieBanner.astro. Astro
 * compiles .ts and .js the same way through Vite, but JS keeps the
 * tooling story simpler for a file that's also literal copy of a TS
 * module — fewer chances for the .d.ts story to drift.
 */

export const CONSENT_POLICY_VERSION = "2026.05.10-v1";

const STORAGE_KEY = "motionmax_cookie_consent_v2";
const LEGACY_KEY = "motionmax_cookie_consent";
const COOKIE_NAME = "motionmax_cookie_consent";

const CONSENT_EVENT = "motionmax:consent-changed";

/**
 * Resolve the parent domain we should pin the shared cookie to.
 *
 * Production: `.motionmax.io` so motionmax.io + app.motionmax.io see the
 * same record. Dev (localhost / 127.0.0.1 / *.local): return null so the
 * cookie defaults to host-only — browsers reject Domain= attributes that
 * don't match a public-suffix-listed parent, and quietly drop the cookie
 * entirely if we set Domain=localhost.
 */
function resolveCookieDomain() {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (!host) return null;
  if (host === "localhost" || host === "127.0.0.1") return null;
  if (host.endsWith(".local")) return null;
  // Match motionmax.io + any subdomain of motionmax.io.
  if (host === "motionmax.io" || host.endsWith(".motionmax.io")) {
    return ".motionmax.io";
  }
  // Preview / vercel.app deployments — fall back to host-only.
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

function deleteCookie(name) {
  if (typeof document === "undefined") return;
  const domain = resolveCookieDomain();
  const parts = [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (domain) parts.push(`Domain=${domain}`);
  document.cookie = parts.join("; ");
  // Belt-and-suspenders: also expire the host-only twin so we don't leave
  // a stale copy when the user toggled domains (preview -> prod).
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function normaliseRecord(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== CONSENT_POLICY_VERSION) return null;
  if (!parsed.categories || typeof parsed.categories !== "object") return null;
  return {
    version: parsed.version,
    timestamp: parsed.timestamp,
    categories: {
      necessary: true,
      functional: !!parsed.categories.functional,
      analytics: !!parsed.categories.analytics,
      marketing: !!parsed.categories.marketing,
    },
  };
}

/**
 * Read the stored consent record. Returns null when no record exists,
 * the version is stale, or the JSON is malformed (banner re-shows).
 *
 * Source-of-truth order: localStorage first (faster, larger); fall back
 * to the cross-subdomain cookie if localStorage is empty (e.g. user came
 * from the React app on app.motionmax.io and answered there). When we
 * rehydrate from cookie, we also push the value back into localStorage
 * so subsequent reads don't pay the cookie-parse cost.
 */
export function getConsent() {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = normaliseRecord(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch {
      /* fall through to cookie */
    }
  }
  // Cross-subdomain rehydrate.
  const cookieRaw = readCookie(COOKIE_NAME);
  if (cookieRaw) {
    try {
      const parsed = normaliseRecord(JSON.parse(cookieRaw));
      if (parsed) {
        if (ls) {
          try {
            ls.setItem(STORAGE_KEY, JSON.stringify(parsed));
          } catch {
            /* ignore quota */
          }
        }
        return parsed;
      }
    } catch {
      /* malformed cookie — treat as no record */
    }
  }
  return null;
}

/**
 * Persist the user's category choices. Writes to BOTH localStorage AND a
 * .motionmax.io-scoped cookie so the React app at app.motionmax.io can
 * see the same answer without re-prompting.
 */
export function setConsent(categories) {
  const record = {
    version: CONSENT_POLICY_VERSION,
    timestamp: new Date().toISOString(),
    categories: {
      necessary: true,
      functional: !!categories.functional,
      analytics: !!categories.analytics,
      marketing: !!categories.marketing,
    },
  };
  const serialised = JSON.stringify(record);
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, serialised);
      ls.removeItem(LEGACY_KEY);
    } catch {
      /* private mode / quota — record exists in-memory only */
    }
  }
  // 1 year — typical CNIL guidance for consent records. Re-shown earlier
  // anyway via CONSENT_POLICY_VERSION bumps when categorisation changes.
  writeCookie(COOKIE_NAME, serialised, 60 * 60 * 24 * 365);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: record }));
  }
  return record;
}

/**
 * Helper for analytics/marketing callers: returns true iff the user has
 * explicitly opted into the given category under the current policy
 * version. "necessary" is always true.
 */
export function hasCategoryConsent(category) {
  if (category === "necessary") return true;
  const record = getConsent();
  if (!record) return false;
  return !!record.categories[category];
}

/**
 * Wipe the stored consent record (forces banner re-show). Used by the
 * "Cookie preferences" link in the footer. GDPR Art. 7(3): withdrawing
 * consent must be as easy as giving it.
 */
export function revokeConsent() {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
      ls.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }
  deleteCookie(COOKIE_NAME);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: null }));
  }
}

/** Subscribe to consent-changed events. Returns an unsubscribe function. */
export function onConsentChange(listener) {
  if (typeof window === "undefined") return () => {};
  const handler = (e) => {
    const detail = e && e.detail !== undefined ? e.detail : null;
    listener(detail);
  };
  window.addEventListener(CONSENT_EVENT, handler);
  return () => window.removeEventListener(CONSENT_EVENT, handler);
}

/** Has the user answered the banner at all under the current policy? */
export function hasAnswered() {
  return getConsent() !== null;
}
