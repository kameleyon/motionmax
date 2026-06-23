/**
 * sandboxJob — worker-side recognition + deterministic terminal result for
 * /api/v1 sandbox (mm_test_) jobs.
 *
 * Roadmap §Phase 2 — Sandbox: "mm_test_ keys exercise full validation/moderation
 * but return deterministic stub assets — no provider spend, no credit deduction."
 *
 * The gateway (api/v1) tags sandbox jobs with payload.sandbox === true and inserts
 * them as ordinary pending rows. Those rows WOULD otherwise be claimed and dispatched
 * to a real provider handler. The worker must short-circuit them to a deterministic
 * terminal-success WITHOUT calling any provider.
 *
 * Why this lives in the worker (and is not imported from api/v1/_shared/sandbox.ts):
 * the worker compiles under its own tsconfig and cannot resolve the api/ tree
 * (separate module resolution, Deno-style imports). So the small, stable pieces the
 * worker needs — the sandbox flag check and the deterministic stub shape — are
 * mirrored here. The stub durations/URL shape MUST stay in sync with
 * api/v1/_shared/sandbox.ts buildSandboxResult so the status handler and the worker
 * agree on what a sandbox result looks like.
 */

/**
 * True when the job payload was tagged as a sandbox (test-env) job by the gateway.
 * Mirrors api/v1/_shared/sandbox.ts isSandboxJob — payload.sandbox === true.
 */
export function isSandboxPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { sandbox?: unknown }).sandbox === true;
}

/** Base host for sandbox placeholder assets (mirror of sandbox.ts sandboxAssetBase). */
function sandboxAssetBase(): string {
  return process.env.SANDBOX_ASSET_BASE ?? "https://app.motionmax.io/sandbox";
}

/**
 * Deterministic stub duration (seconds) per mode — mirrors
 * api/v1/_shared/sandbox.ts SANDBOX_DURATION_S so the worker's terminal write and
 * the gateway's status-handler result are byte-identical for the same mode.
 */
const SANDBOX_DURATION_S: Record<string, number> = {
  doc2video: 30,
  smartflow: 15,
  cinematic: 45,
};

/** Default sandbox format when the request did not pin one. */
const SANDBOX_DEFAULT_FORMAT = "16:9";

export interface SandboxStubResult {
  status: "succeeded";
  video_url: string;
  duration_s: number;
  thumbnail_url: string;
  format: string;
  error: null;
}

/**
 * Best-effort extraction of the requested mode from a job payload. The gateway
 * stores the public mode under payload.mode (doc2video | smartflow | cinematic).
 * Unknown / missing modes fall back to a generic stub.
 */
function modeFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const m = (payload as { mode?: unknown }).mode;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return "sample";
}

/**
 * Best-effort extraction of the requested format (aspect ratio) from a job payload.
 */
function formatFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const f = (payload as { format?: unknown }).format;
    if (typeof f === "string" && f.length > 0) return f;
  }
  return SANDBOX_DEFAULT_FORMAT;
}

/**
 * Build a deterministic, provider-free terminal-success result for a sandbox job.
 * Same shape (status/video_url/duration_s/thumbnail_url/format/error) as
 * api/v1/_shared/sandbox.ts buildSandboxResult. Pure — no I/O, no provider call.
 */
export function buildSandboxJobResult(payload: unknown): SandboxStubResult {
  const mode = modeFromPayload(payload);
  const format = formatFromPayload(payload);
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
