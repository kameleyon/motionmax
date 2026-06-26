// MotionMax Public API — GET /api/v1/videos/{id}
//
// Returns the public status + frozen result schema for a single video job.
//
// Auth:    requireApiKey() (throws a Response on failure — returned verbatim).
// Owner:   the job's account_id MUST equal the authenticated key's account.id.
//          A mismatch (or a missing row) is answered with 404 not_found — never
//          403 — so the endpoint never leaks the existence of another tenant's
//          job (roadmap §3 "owner-checked by api_key_id").
// Result:  internal video_generation_jobs.status (+ error_message) is mapped to
//          the frozen public state via mapInternalToPublicState(); the result
//          jsonb is projected onto the frozen VideoResult shape. video_url is
//          re-signed on demand when the asset lives in a private bucket,
//          otherwise the stored URL is passed through.

import { webHandler } from "../../../_shared/webHandler";
import { handlePreflight } from "../../../_shared/cors";
import { logError } from "../../../_shared/platformConfig";
import { requireApiKey } from "../../../_shared/apiKeyAuth";
import { isSandboxJob, buildSandboxResult } from "../../_shared/sandbox";
import {
  apiError,
  apiJson,
  newRequestId,
  mapInternalToPublicState,
  type ApiJobView,
  type VideoMode,
  type VideoResult,
} from "../../_shared/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Signed-URL retention. Succeeded result assets are re-signed on read so the
// caller always gets a fresh, expiring link rather than a stale one baked in at
// completion time. Matches the roadmap "re-signed on demand, N-day retention".
// ─────────────────────────────────────────────────────────────────────────────

/** Lifetime (seconds) of a re-signed result URL handed to the caller. */
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

/** Storage bucket private result videos are uploaded to by the worker. */
const RESULT_BUCKET = "generated-videos";

/**
 * Published result-retention window (days). A succeeded job whose
 * created_at is older than this is reported as 'expired' (video_url null)
 * because the underlying object has been (or will shortly be) purged from
 * the RESULT_BUCKET. MUST stay in lockstep with the daily pg_cron purge in
 * supabase/migrations/20260525000200_result_retention.sql — the cron deletes
 * the storage object; this constant decides when the read path stops
 * advertising it. Roadmap §Phase 3 (result retention).
 */
const RETENTION_DAYS = 30;

const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Has a succeeded job aged past the published retention window? Returns false
 * for any non-terminal/failed state and whenever created_at is missing or
 * unparseable (fail-open: keep advertising the URL rather than wrongly hiding
 * a still-live asset).
 */
function isResultExpired(createdAt: string | null | undefined): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  return Date.now() - created > RETENTION_MS;
}

/**
 * Minimal shape of the internal job row we read via the service-role client.
 * Only the columns this handler projects are listed; the table has many more.
 */
interface JobRow {
  id: string;
  account_id: string | null;
  task_type: string | null;
  status: string | null;
  error_message: string | null;
  created_at: string | null;
  result: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

/** Extract the `[id]` route segment from the request URL path. */
function extractId(req: Request): string | null {
  try {
    const { pathname } = new URL(req.url);
    const segments = pathname.split("/").filter(Boolean);
    // .../api/v1/videos/<id>   → <id> is the last segment.
    const idx = segments.lastIndexOf("videos");
    if (idx >= 0 && idx + 1 < segments.length) {
      return decodeURIComponent(segments[idx + 1]);
    }
    return null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Provider policy-rejection signatures. When a render fails because the upstream
 * provider refused the CONTENT (not a transient/infra fault), we must NOT leak
 * the raw provider error code to the caller. Instead we normalise it to a
 * stable, documented 422-class code `content_policy` (roadmap §Phase 2
 * "normalize E005 → 422"). E005 is the Hypereal policy-rejection sentinel; the
 * other tokens cover the common cross-provider phrasings.
 */
const POLICY_SIGNATURES: readonly RegExp[] = [
  /\bE005\b/i,
  /content[_\s-]?polic/i, // content_policy / content policy
  /\bpolicy[_\s-]?violation\b/i,
  /\bsafety[_\s-]?(?:reject|block|filter)/i,
  /\bmoderation[_\s-]?(?:reject|block|fail)/i,
  /\bprohibited[_\s-]?content\b/i,
  /\bflagged[_\s-]?(?:as[_\s-]?)?unsafe\b/i,
];

/** Does this failure error_message indicate a provider CONTENT-POLICY rejection? */
function isProviderPolicyRejection(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return POLICY_SIGNATURES.some((re) => re.test(errorMessage));
}

/** Public, generic message shown for a normalised content-policy failure. */
const CONTENT_POLICY_MESSAGE =
  "This request was rejected by the content-safety policy.";

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Re-sign a stored result video URL when it points at our private result
 * bucket; otherwise pass the stored URL through unchanged. Never throws — a
 * signing failure degrades to the stored URL so status reads stay available.
 */
async function resignVideoUrl(
  storedUrl: string | null,
  supabase: import("@supabase/supabase-js").SupabaseClient,
): Promise<string | null> {
  if (!storedUrl) return null;

  // Only attempt to re-sign URLs that reference our private result bucket. The
  // worker uploads finished exports there; older/public assets are passed
  // through verbatim.
  const marker = `/${RESULT_BUCKET}/`;
  const markerIdx = storedUrl.indexOf(marker);
  if (markerIdx === -1) return storedUrl;

  // Object path is everything after the bucket marker, minus any query string.
  const rawPath = storedUrl.slice(markerIdx + marker.length);
  const objectPath = rawPath.split("?")[0];
  if (!objectPath) return storedUrl;

  try {
    const { data, error } = await supabase.storage
      .from(RESULT_BUCKET)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return storedUrl;
    return data.signedUrl;
  } catch {
    return storedUrl;
  }
}

/**
 * Project the internal job row onto the frozen VideoResult. Only succeeded /
 * failed jobs carry a non-null result; queued / processing return null so the
 * caller polls again.
 */
async function buildResult(
  row: JobRow,
  publicState: ReturnType<typeof mapInternalToPublicState>,
  supabase: import("@supabase/supabase-js").SupabaseClient,
): Promise<VideoResult | null> {
  if (publicState === "succeeded" || publicState === "expired") {
    const result = row.result ?? {};
    // The worker writes the final video URL under one of these keys (it is
    // mid-migration from payload.finalUrl → result.url); prefer the canonical
    // result.url first, mirroring src/components/editor/useExport.ts.
    const storedUrl =
      asString(result.url) ??
      asString(result.video_url) ??
      asString((result as { finalUrl?: unknown }).finalUrl) ??
      asString((row.payload ?? {}).finalUrl) ??
      asString((row.payload ?? {}).url);

    const videoUrl =
      publicState === "expired"
        ? null
        : await resignVideoUrl(storedUrl, supabase);

    return {
      status: publicState,
      video_url: videoUrl,
      duration_s:
        asNumber(result.duration_s) ??
        asNumber((result as { duration?: unknown }).duration) ??
        asNumber((result as { durationSeconds?: unknown }).durationSeconds),
      thumbnail_url:
        asString(result.thumbnail_url) ??
        asString((result as { thumbnailUrl?: unknown }).thumbnailUrl),
      format:
        asString(result.format) ??
        asString((row.payload ?? {}).format),
      error: null,
    };
  }

  if (publicState === "failed" || publicState === "cancelled") {
    let errorObj: { code: string; message: string } | null = null;
    if (publicState === "failed") {
      // Normalise upstream content-policy rejections (E005 et al.) to a stable
      // public code + generic message — never leak the raw provider token.
      if (isProviderPolicyRejection(row.error_message)) {
        errorObj = { code: "content_policy", message: CONTENT_POLICY_MESSAGE };
      } else {
        errorObj = {
          code: "generation_failed",
          message: asString(row.error_message) ?? "Video generation failed.",
        };
      }
    }
    return {
      status: publicState,
      video_url: null,
      duration_s: null,
      thumbnail_url: null,
      format: null,
      error: errorObj,
    };
  }

  // queued / processing — no result yet.
  return null;
}

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;
  const origin = req.headers.get("origin");
  const requestId = newRequestId();

  if (req.method !== "GET") {
    return apiError(405, "method_not_allowed", "Use GET to read a video.", origin, requestId);
  }

  try {
    const { account, supabase } = await requireApiKey(req);

    const id = extractId(req);
    if (!id) {
      return apiError(404, "not_found", "Video not found.", origin, requestId);
    }

    const { data, error } = await supabase
      .from("video_generation_jobs")
      .select("id, account_id, task_type, status, error_message, created_at, result, payload")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      logError("api.v1.videos.get.query_failed", error, { requestId, id });
      return apiError(500, "internal_error", "Failed to load video.", origin, requestId);
    }

    const row = data as JobRow | null;

    // Owner check by account_id. A missing row OR a foreign-account row both
    // resolve to 404 so we never confirm the existence of another tenant's job.
    if (!row || row.account_id !== account.id) {
      return apiError(404, "not_found", "Video not found.", origin, requestId);
    }

    // A completed job whose result asset has aged past the retention window is
    // surfaced as 'expired' (video_url null). mapInternalToPublicState only
    // applies resultExpired to the 'completed' case, so passing it
    // unconditionally is safe for queued/processing/failed/cancelled rows.
    const resultExpired = isResultExpired(row.created_at);
    const publicState = mapInternalToPublicState(
      row.status,
      row.error_message,
      resultExpired,
    );
    const mode =
      (asString((row.payload ?? {}).mode) as VideoMode | null) ?? row.task_type ?? "unknown";

    // Sandbox (mm_test_) jobs never touch a provider. The worker short-circuits
    // them to a deterministic terminal-success, but a status read can land while
    // the row is still 'pending'/'processing' (pre-stub). To keep the sandbox a
    // faithful dress-rehearsal of the real polling flow we mirror the row's own
    // public state: terminal-success → the deterministic stub VideoResult;
    // still-in-flight → the same null result a live caller would see and poll on.
    if (isSandboxJob(row.payload)) {
      const format =
        asString((row.payload ?? {}).format) ?? undefined;
      const sandboxResult =
        publicState === "succeeded" || publicState === "expired"
          ? buildSandboxResult(mode, format)
          : null;
      const sandboxView: ApiJobView = {
        id: row.id,
        object: "video",
        status: publicState,
        mode,
        created_at: row.created_at ?? new Date().toISOString(),
        result: sandboxResult,
      };
      return apiJson(200, sandboxView, origin);
    }

    const result = await buildResult(row, publicState, supabase);

    const view: ApiJobView = {
      id: row.id,
      object: "video",
      status: publicState,
      mode,
      created_at: row.created_at ?? new Date().toISOString(),
      result,
    };

    return apiJson(200, view, origin);
  } catch (e) {
    // requireApiKey throws a Response on auth failure — return it verbatim.
    if (e instanceof Response) return e;
    logError("api.v1.videos.get.unhandled", e, { requestId });
    return apiError(500, "internal_error", "Unexpected error.", origin, requestId);
  }
});
