/**
 * Legal document versions — single source of truth.
 *
 * Bump the corresponding string whenever the Terms of Service, Privacy
 * Policy, or Acceptable Use Policy materially change. Each value is
 * written to profiles.{tos,privacy,aup}_version_accepted at signup
 * (and on re-acceptance via TermsUpdateModal). When a stored value
 * differs from the constant here, AuthProvider triggers the
 * re-acceptance modal.
 *
 * Format: YYYY.MM.DD-vN  — calendar date of publication + revision tag.
 *
 * Audit context: B-NEW-13 (Comply L-B-02). Material amendments to
 * unversioned ToS are unenforceable against existing users under UCTD
 * Directive 93/13/EEC; this constant lets us prove which version each
 * user was bound to at signup and re-bind them on amendment.
 *
 * Mirrored on the marketing site (Astro) — those pages import this
 * module directly so the version badge stays in lock-step.
 */
export const LEGAL_VERSIONS = {
  tos: '2026.05.10-v1',
  privacy: '2026.05.10-v1',
  aup: '2026.05.10-v1',
} as const;

export type LegalDoc = keyof typeof LEGAL_VERSIONS;

/** Human-readable "last updated" label rendered next to the version badge. */
export const LEGAL_LAST_UPDATED_LABEL = 'May 10, 2026';

/**
 * Pre-versioning sentinel. All profiles created before B-NEW-13 are
 * backfilled to this value with accepted_at = profiles.created_at.
 * Treat as "unknown legacy version" — these users will be prompted to
 * re-accept on next sign-in.
 */
export const LEGACY_LEGAL_VERSION = '2026.02-v0';
