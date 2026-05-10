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
  // B-NEW-21 (2026-05-10): bumped tos to v2 — "Credits and Billing" §6
  // restated with the new Creator/Studio tier prices, credit allotments
  // and top-up pack ladder. Existing users get the TermsUpdateModal on
  // next sign-in (B-NEW-13 hook compares profiles.tos_version_accepted
  // against this constant).
  // B-NEW-14 (2026-05-10): bumped privacy to v2 — §3 and §4 promised an
  // "AI training opt-in (if you explicitly enable it)" toggle that did
  // not exist in the product. The matching Settings toggle now ships
  // (src/components/settings/AITrainingOptInSection.tsx) backed by
  // profiles.ai_training_opt_in (default FALSE — opt-out posture).
  // Bumping the version forces existing users through TermsUpdateModal
  // so they re-read the policy now that the affordance is real, which
  // closes the FTC §5 strict-liability gap. AUP unchanged this round.
  //
  // Wave 4 / Comply L-C-02..08 (2026-05-10):
  //   • tos    → v3 — added §5.A "No warranty for AI output", §5.B "IP
  //     indemnification" and §5.C "Copyright uncertainty disclosure"
  //     covering Andersen v. Stability AI + Getty v. Stability AI
  //     exposure (C-13-7). Also prepended an English-only disclosure
  //     notice at the top (C-13-8 / Tongue TONGUE-11).
  //   • privacy → v3 — added §X "Voice Biometric Data" classifying
  //     voice-clone audio under BIPA / CUBI / CPRA with explicit
  //     consent + 30-day post-account retention (C-13-3); rewrote §7
  //     to match the actual 7-day grace + immediate-delete behaviour
  //     shipped in Wave 2 B-NEW-6 (C-13-4); promoted the §5
  //     subprocessor list from enterprise-only to publicly enumerated
  //     to satisfy GDPR Art. 28(2) (C-13-5); also prepended the
  //     English-only disclosure notice (C-13-8).
  //   • aup    → v2 — replaced the categorical "no deepfakes" ban with
  //     consent-based synthetic-media language (C-13-2) and added a
  //     §2.x Voice Cloning consent clause; prepended the English-only
  //     notice (C-13-8).
  tos: '2026.05.10-v3',
  privacy: '2026.05.10-v3',
  aup: '2026.05.10-v2',
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
