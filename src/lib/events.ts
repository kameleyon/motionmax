/**
 * Analytics event constants — single source of truth.
 *
 * §11 Lens C3 fix: typo-proofs every `trackEvent(...)` call site by
 * forcing both the firing surface (Voice Lab, Autopost Lab, Intake)
 * and the GA4 funnel queries to use the same exact event name.
 *
 * Naming convention: snake_case lowercase, surface_action shape. Past
 * audits asked for `voice_clone_started` not `clone_voice_start`;
 * `autopost_lab_opened` not `open_autopost_lab`. Keep it consistent.
 *
 * The `as const` assertion lets TypeScript infer literal types, so
 * `EVENTS.voice_lab_opened` has the type `"voice_lab_opened"` not
 * `string` — a typo in a call site is a compile error, not a silent
 * mismatch with the funnel query.
 */
export const EVENTS = {
  // ── Generation activation (Lens C2) ────────────────────────────────
  generation_started: "generation_started",
  generation_completed: "generation_completed",
  generation_failed: "generation_failed",

  // ── Voice Lab (Lens C3) ────────────────────────────────────────────
  voice_lab_opened: "voice_lab_opened",
  voice_clone_started: "voice_clone_started",
  voice_clone_saved: "voice_clone_saved",
  voice_clone_failed: "voice_clone_failed",
  voice_preview_played: "voice_preview_played",

  // ── Autopost Lab (Lens C3) ─────────────────────────────────────────
  autopost_lab_opened: "autopost_lab_opened",
  automation_created: "automation_created",
  automation_run_now: "automation_run_now",
  automation_paused: "automation_paused",
  automation_resumed: "automation_resumed",
  social_account_connected: "social_account_connected",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
