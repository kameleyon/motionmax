/**
 * UTM helpers for the React app — B-NEW-7 (Lens B).
 *
 * Read-side counterpart to `marketing/src/scripts/utmCapture.js`. The
 * marketing site at motionmax.io captures UTM/click-id params on
 * landing and persists them to:
 *
 *   • localStorage["motionmax_utm"]  (per-origin, only motionmax.io)
 *   • cookie  motionmax_utm  Domain=.motionmax.io  (visible to
 *     app.motionmax.io — this is the cross-subdomain handoff path)
 *
 * The app at app.motionmax.io can NOT see motionmax.io's localStorage
 * (cross-origin), so we read the cookie first on a fresh signup, then
 * mirror it into our own localStorage so subsequent reads are fast.
 *
 * Mirrors the rehydrate pattern used by `src/lib/cookieConsent.ts`.
 *
 * Only consumed at signup/signin/checkout — not used as a generic
 * analytics helper. The legacy `getStoredUtm()` in `useAnalytics.ts`
 * (sessionStorage-backed, single-origin) is still used by
 * useSubscription's begin_checkout event; this richer module is the
 * one the auth handoff relies on.
 */

export interface StoredUtms {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  gclid: string | null;
  fbclid: string | null;
  captured_at: string;
  landing_url: string;
}

const STORAGE_KEY = "motionmax_utm";
const COOKIE_NAME = "motionmax_utm";

/**
 * Resolve the parent domain for cookie writes — same logic as
 * cookieConsent.ts. Returns null in dev / preview where cookies fall
 * back to host-only.
 */
function resolveCookieDomain(): string | null {
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

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readCookie(name: string): string | null {
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

function deleteCookie(name: string): void {
  if (typeof document === "undefined") return;
  const domain = resolveCookieDomain();
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  document.cookie = parts.join("; ");
  // Belt-and-suspenders: also expire the host-only twin.
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function normalise(parsed: unknown): StoredUtms | null {
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.captured_at !== "string") return null;
  return {
    source:   typeof r.source   === "string" ? r.source   : null,
    medium:   typeof r.medium   === "string" ? r.medium   : null,
    campaign: typeof r.campaign === "string" ? r.campaign : null,
    term:     typeof r.term     === "string" ? r.term     : null,
    content:  typeof r.content  === "string" ? r.content  : null,
    gclid:    typeof r.gclid    === "string" ? r.gclid    : null,
    fbclid:   typeof r.fbclid   === "string" ? r.fbclid   : null,
    captured_at: r.captured_at,
    landing_url: typeof r.landing_url === "string" ? r.landing_url : "",
  };
}

/**
 * Read the persisted UTM record. Source-of-truth order:
 *   1. localStorage (fast path, same-origin).
 *   2. Cross-subdomain cookie (.motionmax.io).
 * When we rehydrate from cookie we also push the value back into
 * localStorage so subsequent reads avoid re-parsing the cookie jar.
 *
 * Returns null when no record exists or the JSON is malformed —
 * callers MUST be safe with null (an organic signup with no prior ad
 * touchpoint is the common case).
 */
export function getStoredUtms(): StoredUtms | null {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = normalise(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch {
      /* fall through to cookie */
    }
  }
  const cookieRaw = readCookie(COOKIE_NAME);
  if (cookieRaw) {
    try {
      const parsed = normalise(JSON.parse(cookieRaw));
      if (parsed) {
        if (ls) {
          try {
            ls.setItem(STORAGE_KEY, JSON.stringify(parsed));
          } catch {
            /* quota — ignore */
          }
        }
        return parsed;
      }
    } catch {
      /* malformed — treat as no record */
    }
  }
  return null;
}

/**
 * Wipe the UTM record after it has been written to the user's
 * profile. Without this, a second signup from the same browser (e.g.
 * dev testing, shared computer) would attach the SAME ad-click
 * attribution to a different account — corrupting the funnel.
 *
 * Removes both the localStorage entry and the .motionmax.io cookie so
 * the marketing site's next visit gets a clean first-touch.
 */
export function clearStoredUtms(): void {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  deleteCookie(COOKIE_NAME);
}

/**
 * Flatten the stored UTM blob into the GA-style param shape
 * (utm_source, utm_medium, …) suitable for stuffing into a gtag
 * event payload. Excludes nulls so we don't ship empty fields.
 */
export function utmsToEventParams(
  utms: StoredUtms | null,
): Record<string, string> {
  if (!utms) return {};
  const out: Record<string, string> = {};
  if (utms.source)   out.utm_source   = utms.source;
  if (utms.medium)   out.utm_medium   = utms.medium;
  if (utms.campaign) out.utm_campaign = utms.campaign;
  if (utms.term)     out.utm_term     = utms.term;
  if (utms.content)  out.utm_content  = utms.content;
  if (utms.gclid)    out.gclid        = utms.gclid;
  if (utms.fbclid)   out.fbclid       = utms.fbclid;
  return out;
}
