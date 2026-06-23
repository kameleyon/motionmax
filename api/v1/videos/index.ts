/**
 * POST /api/v1/videos   — create a video-generation job (async, returns 202).
 * GET  /api/v1/videos   — list this account's jobs (cursor paginated).
 *
 * Public gateway entrypoint (roadmap Phase 1 §"Gateway"). Authenticates with a
 * customer API key (`requireApiKey`), validates + moderates (FAIL-CLOSED) the
 * request, prices to the worst provider rung, deducts credits idempotently, and
 * enqueues a `video_generation_jobs` row via the service role. Everything the
 * caller sees is mapped through the frozen contract — no internal columns leak.
 *
 * Ownership: this file owns the collection routes only. The item routes
 * (`/api/v1/videos/{id}`, `…/cancel`) live in sibling handlers.
 */

import { webHandler } from "../../_shared/webHandler";
import { handlePreflight } from "../../_shared/cors";
import { logError } from "../../_shared/platformConfig";
import { isResponse } from "../../_shared/auth";
import { requireApiKey } from "../../_shared/apiKeyAuth";
import { moderateOrThrow } from "../_shared/moderation";
import { priceRequest } from "../_shared/pricing";
import { SANDBOX_PAYLOAD_FLAG } from "../_shared/sandbox";
import {
  apiError,
  apiJson,
  newRequestId,
  mapInternalToPublicState,
  type ApiJobView,
  type ApiKeyAuthOk,
  type CreateVideoRequest,
  type VideoMode,
  type VideoLength,
} from "../_shared/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES: ReadonlySet<string> = new Set<VideoMode>([
  "doc2video",
  "smartflow",
  "cinematic",
]);

const VALID_LENGTHS: ReadonlySet<string> = new Set<VideoLength>([
  "short",
  "brief",
  "presentation",
]);

const DEFAULT_LENGTH: VideoLength = "brief";
const DEFAULT_FORMAT = "16:9";
const MAX_PROMPT_CHARS = 20_000;
const MAX_ATTACHMENTS = 25;

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

/**
 * Internal task_type derived from the public `mode`. The browser path enqueues
 * the same task_type strings the worker claims on.
 */
const MODE_TO_TASK_TYPE: Record<VideoMode, string> = {
  doc2video: "doc2video",
  smartflow: "smartflow",
  cinematic: "cinematic_video",
};

/** Higher number = served first by claim_pending_job priority ordering. */
const TIER_PRIORITY: Record<string, number> = {
  studio: 30,
  creator: 20,
  free: 10,
};

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (internal substrate — kept local, never exported).
// ─────────────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  task_type: string | null;
  status: string | null;
  payload: unknown;
  error_message: string | null;
  created_at: string;
}

/** Build the frozen public view of a freshly-created or listed job row. */
function toApiJobView(row: JobRow, mode: VideoMode | string): ApiJobView {
  return {
    id: row.id,
    object: "video",
    status: mapInternalToPublicState(row.status, row.error_message),
    mode,
    created_at: row.created_at,
    result: null,
  };
}

/** Recover the public `mode` for a listed row from its stored payload/task_type. */
function modeFromRow(row: JobRow): VideoMode | string {
  const payload = row.payload as { mode?: unknown } | null | undefined;
  if (payload && typeof payload.mode === "string") return payload.mode;
  // Fallback: invert the task_type mapping.
  for (const [mode, taskType] of Object.entries(MODE_TO_TASK_TYPE)) {
    if (taskType === row.task_type) return mode;
  }
  return row.task_type ?? "doc2video";
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing / validation
// ─────────────────────────────────────────────────────────────────────────────

type ValidationResult =
  | { ok: true; value: CreateVideoRequest }
  | { ok: false; message: string };

function validateCreateBody(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }
  const body = raw as Record<string, unknown>;

  // prompt — required, non-empty string.
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return { ok: false, message: "`prompt` is required and must be a non-empty string." };
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return { ok: false, message: `\`prompt\` exceeds the ${MAX_PROMPT_CHARS} character limit.` };
  }

  // mode — required, enum.
  if (typeof body.mode !== "string" || !VALID_MODES.has(body.mode)) {
    return {
      ok: false,
      message: "`mode` is required and must be one of: doc2video, smartflow, cinematic.",
    };
  }

  // length — optional, enum.
  if (body.length !== undefined) {
    if (typeof body.length !== "string" || !VALID_LENGTHS.has(body.length)) {
      return {
        ok: false,
        message: "`length` must be one of: short, brief, presentation.",
      };
    }
  }

  // format — optional, string.
  if (body.format !== undefined && typeof body.format !== "string") {
    return { ok: false, message: "`format` must be a string." };
  }

  // voice — optional, string.
  if (body.voice !== undefined && typeof body.voice !== "string") {
    return { ok: false, message: "`voice` must be a string." };
  }

  // language — optional, string.
  if (body.language !== undefined && typeof body.language !== "string") {
    return { ok: false, message: "`language` must be a string." };
  }

  // attachments — optional, string[] of URLs.
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) {
      return { ok: false, message: "`attachments` must be an array of URL strings." };
    }
    if (body.attachments.length > MAX_ATTACHMENTS) {
      return { ok: false, message: `\`attachments\` may contain at most ${MAX_ATTACHMENTS} items.` };
    }
    for (const a of body.attachments) {
      if (typeof a !== "string" || a.trim().length === 0) {
        return { ok: false, message: "Each attachment must be a non-empty URL string." };
      }
    }
  }

  // idempotency_key — optional, string.
  if (body.idempotency_key !== undefined && typeof body.idempotency_key !== "string") {
    return { ok: false, message: "`idempotency_key` must be a string." };
  }

  // callback_url — optional, string URL.
  if (body.callback_url !== undefined) {
    if (typeof body.callback_url !== "string") {
      return { ok: false, message: "`callback_url` must be a string URL." };
    }
    try {
      const u = new URL(body.callback_url);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { ok: false, message: "`callback_url` must be an http(s) URL." };
      }
    } catch {
      return { ok: false, message: "`callback_url` must be a valid URL." };
    }
  }

  const value: CreateVideoRequest = {
    prompt: body.prompt,
    mode: body.mode as VideoMode,
    length: body.length as VideoLength | undefined,
    format: body.format as string | undefined,
    voice: body.voice as string | undefined,
    language: body.language as string | undefined,
    attachments: body.attachments as string[] | undefined,
    idempotency_key: body.idempotency_key as string | undefined,
    callback_url: body.callback_url as string | undefined,
  };
  return { ok: true, value };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — create a job.
// ─────────────────────────────────────────────────────────────────────────────

async function handleCreate(
  req: Request,
  auth: ApiKeyAuthOk,
  origin: string | null,
  requestId: string,
): Promise<Response> {
  const { apiKey, account, supabase } = auth;

  // 1) Parse body.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError(400, "invalid_request", "Request body must be valid JSON.", origin, requestId);
  }

  // 2) Validate.
  const validated = validateCreateBody(raw);
  if (!validated.ok) {
    return apiError(400, "invalid_request", validated.message, origin, requestId);
  }
  const body = validated.value;
  const mode = body.mode;
  const length = body.length ?? DEFAULT_LENGTH;
  const format = body.format ?? DEFAULT_FORMAT;

  // 3) Moderate (FAIL-CLOSED — moderateOrThrow throws a Response on block/error).
  await moderateOrThrow(
    { prompt: body.prompt, attachments: body.attachments },
    origin,
  );

  const isSandbox = apiKey.env === "test";

  // 4) Resolve idempotency key (body wins, else Idempotency-Key header).
  const idempotencyKey =
    body.idempotency_key ?? req.headers.get("idempotency-key") ?? null;

  // Live (billed) submits MUST carry an idempotency key so a retried POST — the
  // norm for async APIs — is billed exactly once and is crash-safe between the
  // credit deduction and the job INSERT. Sandbox keys are unbilled, so optional.
  if (!isSandbox && !idempotencyKey) {
    return apiError(
      400,
      "idempotency_key_required",
      "Live API requests require an `idempotency_key` (request body or Idempotency-Key header) so retries are billed exactly once.",
      origin,
      requestId,
    );
  }

  // 5) Idempotent replay — return the existing job for (api_key_id, idem_key).
  if (idempotencyKey) {
    const { data: existing, error: replayErr } = await supabase
      .from("video_generation_jobs")
      .select("id, task_type, status, payload, error_message, created_at")
      .eq("api_key_id", apiKey.id)
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle();

    if (replayErr) {
      logError("api.v1.videos.create.replay_lookup", replayErr, { requestId });
      return apiError(500, "internal_error", "Failed to check for an existing job.", origin, requestId);
    }
    if (existing) {
      // Idempotent replay: return the original job, do NOT re-deduct or re-enqueue.
      return apiJson(202, toApiJobView(existing as JobRow, mode), origin);
    }
  }

  // 6) Price the request (worst-rung × margin → credits).
  const quote = priceRequest(mode, length, format);
  const credits = quote.credits;

  const billedAt = new Date().toISOString();

  // 7) Deduct credits — live keys only. Sandbox skips billing + provider spend.
  if (!isSandbox) {
    const { data: deducted, error: deductErr } = await supabase.rpc("deduct_credits_securely", {
      p_user_id: account.owner_user_id,
      p_amount: credits,
      p_transaction_type: "api_generation",
      p_description: `API video generation (${mode}/${length})`,
      // Scope the deduct idempotency to (api_key, key) — the SAME grain as the
      // job replay lookup + uq_video_jobs_api_idempotency — so the credit ledger
      // and the job table agree on what "the same request" means. (live always
      // has idempotencyKey: it is required above.)
      p_idempotency_key: idempotencyKey ? `${apiKey.id}:${idempotencyKey}` : null,
    });

    if (deductErr) {
      logError("api.v1.videos.create.deduct", deductErr, { requestId });
      return apiError(500, "internal_error", "Failed to charge credits.", origin, requestId);
    }
    if (deducted === false) {
      return apiError(
        402,
        "insufficient_credits",
        `This request requires ${credits} credits and the account balance is insufficient.`,
        origin,
        requestId,
      );
    }
  }

  // 8) Build the job payload (full request body + sandbox/quote breadcrumbs).
  const payload: Record<string, unknown> = {
    prompt: body.prompt,
    mode,
    length,
    format,
    voice: body.voice,
    language: body.language,
    attachments: body.attachments,
    source: "api_v1",
    credits_charged: isSandbox ? 0 : credits,
    // Mirror the charge under the codebase-standard field the worker reads for
    // margin reconciliation (worker/src/index.ts) and the browser refund path.
    creditsDeducted: isSandbox ? 0 : credits,
    price_quote: {
      credits: quote.credits,
      worst_rung_usd: quote.worst_rung_usd,
      margin_multiplier: quote.margin_multiplier,
    },
  };
  if (isSandbox) {
    // Canonical flag the worker/status readers check via isSandboxJob().
    payload[SANDBOX_PAYLOAD_FLAG] = true;
  }

  const taskType = MODE_TO_TASK_TYPE[mode];
  const priority = TIER_PRIORITY[account.tier] ?? TIER_PRIORITY.free;

  // 9) Enqueue via service role. New API columns set alongside the legacy ones.
  const { data: inserted, error: insertErr } = await supabase
    .from("video_generation_jobs")
    .insert({
      user_id: account.owner_user_id,
      project_id: null,
      task_type: taskType,
      status: "pending",
      payload,
      api_key_id: apiKey.id,
      account_id: account.id,
      idempotency_key: idempotencyKey,
      callback_url: body.callback_url ?? null,
      billed_at: isSandbox ? null : billedAt,
      priority,
    })
    .select("id, task_type, status, payload, error_message, created_at")
    .single();

  if (insertErr || !inserted) {
    // Refund on enqueue failure so the caller isn't charged for a dropped job.
    if (!isSandbox) {
      const { error: refundErr } = await supabase.rpc("refund_credits_securely", {
        p_user_id: account.owner_user_id,
        p_amount: credits,
        p_description: `Refund — API enqueue failed (req ${requestId})`,
      });
      if (refundErr) {
        logError("api.v1.videos.create.refund_after_insert_fail", refundErr, { requestId });
      }
    }
    logError("api.v1.videos.create.insert", insertErr, { requestId });
    return apiError(500, "internal_error", "Failed to enqueue the job.", origin, requestId);
  }

  // 10) 202 Accepted with the frozen public view.
  return apiJson(202, toApiJobView(inserted as JobRow, mode), origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — list this account's jobs (cursor paginated, owner-scoped by account_id).
// ─────────────────────────────────────────────────────────────────────────────

async function handleList(
  req: Request,
  auth: ApiKeyAuthOk,
  origin: string | null,
  requestId: string,
): Promise<Response> {
  const { account, supabase } = auth;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return apiError(400, "invalid_request", "Unparseable request URL.", origin, requestId);
  }

  // limit — clamp to [1, LIST_MAX_LIMIT].
  let limit = LIST_DEFAULT_LIMIT;
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return apiError(400, "invalid_request", "`limit` must be a positive integer.", origin, requestId);
    }
    limit = Math.min(parsed, LIST_MAX_LIMIT);
  }

  // cursor — opaque ISO timestamp (created_at of the last row from the prior page).
  const cursor = url.searchParams.get("cursor");

  let query = supabase
    .from("video_generation_jobs")
    .select("id, task_type, status, payload, error_message, created_at")
    .eq("account_id", account.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1); // fetch one extra to detect a next page.

  if (cursor) {
    const ts = new Date(cursor);
    if (Number.isNaN(ts.getTime())) {
      return apiError(400, "invalid_request", "`cursor` is not a valid pagination token.", origin, requestId);
    }
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    logError("api.v1.videos.list", error, { requestId });
    return apiError(500, "internal_error", "Failed to list jobs.", origin, requestId);
  }

  const rows = (data ?? []) as JobRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: ApiJobView[] = page.map((row) => toApiJobView(row, modeFromRow(row)));
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;

  return apiJson(200, { data: items, next_cursor: nextCursor }, origin);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint.
// ─────────────────────────────────────────────────────────────────────────────

export default webHandler(async (req: Request): Promise<Response> => {
  const pf = handlePreflight(req);
  if (pf) return pf;

  const origin = req.headers.get("origin");
  const requestId = newRequestId();
  const method = (req.method || "GET").toUpperCase();

  // Method gate.
  if (method !== "POST" && method !== "GET") {
    return apiError(405, "method_not_allowed", `Method ${method} is not allowed.`, origin, requestId);
  }

  // Authenticate — requireApiKey throws a Response on failure.
  let auth: ApiKeyAuthOk;
  try {
    auth = await requireApiKey(req);
  } catch (e) {
    if (isResponse(e)) return e;
    logError("api.v1.videos.auth", e, { requestId });
    return apiError(500, "internal_error", "Authentication failed.", origin, requestId);
  }

  try {
    if (method === "POST") {
      return await handleCreate(req, auth, origin, requestId);
    }
    return await handleList(req, auth, origin, requestId);
  } catch (e) {
    // moderateOrThrow (and any other guard) throws a Response — return verbatim.
    if (isResponse(e)) return e;
    logError("api.v1.videos.handler", e, { requestId });
    return apiError(500, "internal_error", "An unexpected error occurred.", origin, requestId);
  }
});
