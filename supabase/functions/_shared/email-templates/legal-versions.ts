// Edge-function-side mirror of src/config/legal-versions.ts so the
// lifecycle email footer can stamp the current ToS version without
// reaching across the tree. Bump in BOTH places when you cut a new
// legal version (the app uses src/config/legal-versions.ts; this
// file is read only by Resend dispatchers and the receipt template).
//
// Last sync: 2026-05-10 (Wave E-Legal — tos v4, privacy v4, aup v3).
// See src/config/legal-versions.ts header for the full changelog.
export const LEGAL_VERSIONS = {
  tos: "2026.05.10-v4",
  privacy: "2026.05.10-v4",
  aup: "2026.05.10-v3",
} as const;
