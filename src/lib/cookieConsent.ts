/**
 * Cookie consent registry — GDPR Art. 7 / CNIL / Garante compliant.
 *
 * This module is the single source of truth for what the user has agreed
 * to. It is intentionally framework-agnostic (pure TS + localStorage) so
 * non-React call sites (analytics scripts, Sentry, error boundaries) can
 * gate themselves with `hasCategoryConsent('analytics')` without pulling
 * in React.
 *
 * ── Why per-category instead of a binary accept/reject ─────────────────
 * CNIL deliberation SAN-2022-024 and Garante ord. 9870832 cited cookie
 * banners that failed to offer GRANULAR controls before "accept". The
 * fixed cure here:
 *   • Necessary  — always-on (auth, security, billing). Not user-optional.
 *   • Functional — language preference, theme persistence.
 *   • Analytics  — Sentry Session Replay, Google Analytics 4 page views.
 *   • Marketing  — pixel-tracking, retargeting (none currently used).
 *
 * Each non-necessary category is OFF by default. The banner offers
 * "Accept all", "Reject all", and "Save preferences" as equally
 * prominent siblings (GDPR Art. 7(3): withdrawal as easy as consent).
 *
 * ── Versioning ────────────────────────────────────────────────────────
 * `CONSENT_POLICY_VERSION` MUST be bumped whenever the categorisation
 * itself changes (e.g. a new vendor in "analytics", or splitting
 * "marketing" into two). On version mismatch the banner re-shows so the
 * user can re-affirm. This is the EU "informed consent" requirement when
 * the basis for processing materially changes.
 */

export const CONSENT_POLICY_VERSION = "2026.05.10-v1";

const STORAGE_KEY = "motionmax_cookie_consent_v2";
// Legacy key from the binary Accept/Reject banner (pre-2026-05-10). We
// intentionally do NOT migrate it: the previous banner did not collect
// granular categories, so accepting that record would be a unilateral
// downgrade of the consent record. Users get one banner re-show.
const LEGACY_KEY = "motionmax_cookie_consent";

export type CookieCategory = "functional" | "analytics" | "marketing";

export interface ConsentCategories {
  /** Always implicitly true; included for completeness. */
  necessary: true;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

export interface StoredConsent {
  version: string;
  /** ISO timestamp of when the user saved the preference. */
  timestamp: string;
  categories: ConsentCategories;
}

// ── Browser-listener channel ────────────────────────────────────────────
// Same-tab callers (Settings page, footer link) need to react when the
// banner saves consent. We dispatch a CustomEvent on window so any number
// of listeners can subscribe without coupling.
const CONSENT_EVENT = "motionmax:consent-changed";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read the stored consent record. Returns `null` if no record exists,
 *  the stored version is stale, or the JSON is malformed (banner re-shows). */
export function getConsent(): StoredConsent | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConsent;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== CONSENT_POLICY_VERSION) {
      // Material policy update — treat as no-consent so banner re-shows.
      return null;
    }
    if (!parsed.categories || typeof parsed.categories !== "object") return null;
    // Defensive: ensure flag types.
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
  } catch {
    return null;
  }
}

/** Persist the user's category choices. Stamps with the current policy
 *  version + an ISO timestamp so we have an audit trail. */
export function setConsent(categories: {
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}): StoredConsent {
  const record: StoredConsent = {
    version: CONSENT_POLICY_VERSION,
    timestamp: new Date().toISOString(),
    categories: {
      necessary: true,
      functional: categories.functional,
      analytics: categories.analytics,
      marketing: categories.marketing,
    },
  };
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(record));
      // Sweep the legacy binary record once we have a v2 record so it
      // doesn't keep returning stale answers from older code paths.
      ls.removeItem(LEGACY_KEY);
    } catch {
      /* private mode / quota — record exists in-memory only */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: record }));
  }
  return record;
}

/** Helper for analytics/marketing callers: returns true if the user has
 *  explicitly opted into the given category under the current policy
 *  version. Necessary is always true. */
export function hasCategoryConsent(category: "necessary" | CookieCategory): boolean {
  if (category === "necessary") return true;
  const record = getConsent();
  if (!record) return false;
  return !!record.categories[category];
}

/** Wipe the stored consent record (forces banner re-show). Used by the
 *  "Forget my preferences" button in Settings and the footer link.
 *  GDPR Art. 7(3): withdrawing consent must be as easy as giving it. */
export function revokeConsent(): void {
  const ls = safeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(STORAGE_KEY);
      ls.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: null }));
  }
}

/** Subscribe to consent-changed events. Returns an unsubscribe function. */
export function onConsentChange(
  listener: (record: StoredConsent | null) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<StoredConsent | null>).detail;
    listener(detail ?? null);
  };
  window.addEventListener(CONSENT_EVENT, handler);
  return () => window.removeEventListener(CONSENT_EVENT, handler);
}

/** Has the user answered the banner at all under the current policy? */
export function hasAnswered(): boolean {
  return getConsent() !== null;
}
