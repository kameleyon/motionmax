/**
 * /api/v1 sandbox (test-mode) stub.
 *
 * `mm_test_` API keys exercise the full request path — auth, validation,
 * moderation — but MUST NOT spend on real providers or deduct credits
 * (roadmap §Phase 2: "mm_test_ keys ... return deterministic stub assets — no
 * provider spend, no credit deduction"). When the gateway detects a test-env
 * key it short-circuits enqueue and returns a deterministic, video-shaped
 * VideoResult built here.
 *
 * The assets are stable placeholder URLs that never hit a provider. They are
 * deterministic per mode so SDK/integration tests can assert on them.
 */

import type { VideoResult, VideoMode } from "./contract";

/** Base host for sandbox placeholder assets (overridable for self-hosting). */
function sandboxAssetBase(): string {
  return process.env.SANDBOX_ASSET_BASE ?? "https://app.motionmax.io/sandbox";
}

/**
 * Deterministic stub duration (seconds) per mode. These mirror the rough shape
 * of a real render without implying any real billing tier.
 */
const SANDBOX_DURATION_S: Record<string, number> = {
  doc2video: 30,
  smartflow: 15,
  cinematic: 45,
};

/** Default sandbox format when the request does not pin one. */
const SANDBOX_DEFAULT_FORMAT = "16:9";

/**
 * Build a deterministic, provider-free VideoResult for a sandbox job. `mode`
 * selects the stub duration/asset slug; unknown modes get a generic stub.
 */
export function buildSandboxResult(
  mode: string,
  format: string = SANDBOX_DEFAULT_FORMAT,
): VideoResult {
  const base = sandboxAssetBase();
  const slug = SANDBOX_DURATION_S[mode] ? mode : "sample";
  const duration = SANDBOX_DURATION_S[mode] ?? 20;

  return {
    status: "succeeded",
    video_url: `${base}/${slug}.mp4`,
    duration_s: duration,
    thumbnail_url: `${base}/${slug}.jpg`,
    format,
    error: null,
  };
}

/**
 * Sandbox jobs are tagged in their payload so downstream readers (status/list
 * handlers, the worker claim path) can recognise them without re-deriving the
 * key env. The gateway sets payload.sandbox = true for test-env keys.
 */
export function isSandboxJob(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const sandbox = (payload as { sandbox?: unknown }).sandbox;
  return sandbox === true;
}

/** Re-export for callers building a payload, to avoid magic strings. */
export const SANDBOX_PAYLOAD_FLAG = "sandbox" as const;

/** Narrowing helper: is this a mode we model with a specific stub? */
export function isKnownSandboxMode(mode: string): mode is VideoMode {
  return mode === "doc2video" || mode === "smartflow" || mode === "cinematic";
}
