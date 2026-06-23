/**
 * apiResultNormalize — worker-side mirror of the /api/v1 GET handler's contract
 * mapping (api/v1/videos/[id]/index.ts).
 *
 * The webhook surface MUST emit the exact same `data` block a customer would
 * GET /videos/{id} for the same job (Phase 2 parity requirement). The worker
 * cannot import the api/ tree (separate tsconfig + module resolution), so the
 * normalization logic is duplicated here and kept in lockstep.
 *
 * ⚠️  IF YOU CHANGE THE FALLBACK CHAINS OR POLICY SIGNATURES HERE, CHANGE THEM
 *     IN api/v1/videos/[id]/index.ts (buildResult / POLICY_SIGNATURES) TOO —
 *     and vice-versa. The two are a single contract split across two builds.
 *
 * Note on the merged payload: the worker writes `cleanPayload` to BOTH the
 * `result` and `payload` columns of video_generation_jobs, so the GET handler's
 * `result.X ?? payload.Y` fallbacks collapse, here, to reading the variants off
 * the single cleanPayload object.
 */

/** Public result shape — identical to api/v1 VideoResult. */
export interface PublicVideoResult {
  status: "succeeded" | "failed";
  video_url: string | null;
  duration_s: number | null;
  thumbnail_url: string | null;
  format: string | null;
  error: { code: string; message: string } | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── Provider content-policy normalization — MIRRORS the GET handler ───────────
// Keep these regexes byte-identical to POLICY_SIGNATURES in
// api/v1/videos/[id]/index.ts.
export const POLICY_SIGNATURES: readonly RegExp[] = [
  /\bE005\b/i,
  /content[_\s-]?polic/i,
  /\bpolicy[_\s-]?violation\b/i,
  /\bsafety[_\s-]?(?:reject|block|filter)/i,
  /\bmoderation[_\s-]?(?:reject|block|fail)/i,
  /\bprohibited[_\s-]?content\b/i,
  /\bflagged[_\s-]?(?:as[_\s-]?)?unsafe\b/i,
];

export const CONTENT_POLICY_MESSAGE =
  "This request was rejected by the content-safety policy.";

export function isProviderPolicyRejection(
  errorMessage: string | null | undefined,
): boolean {
  if (!errorMessage) return false;
  return POLICY_SIGNATURES.some((re) => re.test(errorMessage));
}

/**
 * Build the success `data` block from the worker's cleanPayload, using the SAME
 * key fallbacks as the GET handler's succeeded branch. (We do not re-sign the
 * URL here as the GET path does on demand — the webhook delivers the stored URL;
 * customers who need a fresh signed link GET /videos/{id}.)
 */
export function normalizeSuccessResult(
  payload: Record<string, unknown> | null | undefined,
): PublicVideoResult {
  const p = payload ?? {};
  return {
    status: "succeeded",
    video_url:
      asString(p.url) ??
      asString(p.video_url) ??
      asString((p as { finalUrl?: unknown }).finalUrl),
    duration_s:
      asNumber(p.duration_s) ??
      asNumber((p as { duration?: unknown }).duration) ??
      asNumber((p as { durationSeconds?: unknown }).durationSeconds),
    thumbnail_url:
      asString(p.thumbnail_url) ??
      asString((p as { thumbnailUrl?: unknown }).thumbnailUrl),
    format: asString(p.format),
    error: null,
  };
}

/**
 * Build the failure `error` object from the stored error_message, using the
 * SAME normalization as the GET handler's failed branch: content-policy
 * rejections collapse to a stable `content_policy` code + generic message (no
 * raw provider token), everything else is `generation_failed` with the stored
 * message (which the GET path also surfaces).
 */
export function normalizeFailureError(
  errorMessage: string | null | undefined,
): { code: string; message: string } {
  if (isProviderPolicyRejection(errorMessage)) {
    return { code: "content_policy", message: CONTENT_POLICY_MESSAGE };
  }
  return {
    code: "generation_failed",
    message: asString(errorMessage) ?? "Video generation failed.",
  };
}
