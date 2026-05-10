// Edge-function-side mirror of src/config/legal-versions.ts so the
// lifecycle email footer can stamp the current ToS version without
// reaching across the tree. Bump in BOTH places when you cut a new
// legal version (the app uses src/config/legal-versions.ts; this
// file is read only by Resend dispatchers and the receipt template).
//
// Last sync: 2026-05-10 (B-NEW-21 — tos bumped to v2 alongside the
// Wave 4 lifecycle email rollout).
export const LEGAL_VERSIONS = {
  tos: "2026.05.10-v2",
  privacy: "2026.05.10-v2",
  aup: "2026.05.10-v1",
} as const;
