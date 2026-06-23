// MotionMax Public API — /api/v1 frozen contract.
//
// This file is the SINGLE SOURCE OF TRUTH for the public API surface. Every
// /api/v1 handler and shared module imports its types and helpers from here.
// The public state enum and result schema are *mapped over* the internal
// `video_generation_jobs` representation so internal refactors can never shift
// what a paying caller sees (roadmap §3 "public state enum mapped over internal
// status", §3 "frozen result schema").
//
// DO NOT add provider-specific or internal-only fields to the public types
// below. Internal columns stay internal; the mapping functions are the only
// bridge.

import type { SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders } from "../../_shared/cors";

// ─────────────────────────────────────────────────────────────────────────────
// Public job state (frozen). Mapped over internal status
// ('pending'|'processing'|'completed'|'failed'|'cancelled').
// ─────────────────────────────────────────────────────────────────────────────
export type PublicJobState =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Map the internal video_generation_jobs.status (+ error_message) onto the
 * frozen public state enum. The ONLY place this mapping is allowed to live.
 *
 * Internal → public:
 *   pending    → queued
 *   processing → processing
 *   completed  → succeeded
 *   cancelled  → cancelled            (post-migration status; see jobs migration)
 *   failed     → cancelled, if the failure was a user/cancel sentinel
 *              → failed,    otherwise
 *
 * `expired` is NOT an internal status — it is derived at read time when a
 * succeeded job's result assets are past the published retention window. Pass
 * `resultExpired=true` to surface it.
 */
export function mapInternalToPublicState(
  internalStatus: string | null | undefined,
  errorMessage?: string | null,
  resultExpired = false,
): PublicJobState {
  switch (internalStatus) {
    case "pending":
      return "queued";
    case "processing":
      return "processing";
    case "completed":
      return resultExpired ? "expired" : "succeeded";
    case "cancelled":
      return "cancelled";
    case "failed":
      return isCancelSentinel(errorMessage) ? "cancelled" : "failed";
    default:
      // Unknown/legacy internal status is treated as queued rather than leaking
      // an internal token to the caller.
      return "queued";
  }
}

/** Cancellations are stored on legacy rows as failed + a sentinel message. */
export function isCancelSentinel(errorMessage?: string | null): boolean {
  return typeof errorMessage === "string" && /cancel/i.test(errorMessage);
}

export const TERMINAL_PUBLIC_STATES: ReadonlySet<PublicJobState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Public request / response shapes (frozen).
// ─────────────────────────────────────────────────────────────────────────────

export type VideoMode = "doc2video" | "smartflow" | "cinematic";
export type VideoLength = "short" | "brief" | "presentation";

/** POST /api/v1/videos request body. */
export interface CreateVideoRequest {
  prompt: string;
  mode: VideoMode;
  length?: VideoLength;
  format?: string; // e.g. "16:9" | "9:16" | "1:1"; defaulted by the handler
  voice?: string;
  language?: string;
  attachments?: string[]; // URLs (SSRF-allowlisted at moderation time)
  idempotency_key?: string; // may also arrive via Idempotency-Key header
  callback_url?: string; // webhook target for terminal transitions
}

/** Frozen result schema. video_url is signed + expiring; re-signed on demand. */
export interface VideoResult {
  status: PublicJobState;
  video_url: string | null;
  duration_s: number | null;
  thumbnail_url: string | null;
  format: string | null;
  error: { code: string; message: string } | null;
}

/** The public view of a job returned by create / status / list. */
export interface ApiJobView {
  id: string;
  object: "video";
  status: PublicJobState;
  mode: VideoMode | string;
  created_at: string;
  result: VideoResult | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth types — implemented by api/_shared/apiKeyAuth.ts requireApiKey().
// Defined here so every handler shares one shape.
// ─────────────────────────────────────────────────────────────────────────────

export type ApiKeyEnv = "live" | "test";

export interface ApiKeyRecord {
  id: string;
  account_id: string;
  env: ApiKeyEnv; // 'test' keys run the sandbox path (no provider spend)
  prefix: string; // e.g. "mm_live_" / "mm_test_"
  scopes: string[];
  status: "active" | "rotated" | "revoked";
}

export interface AccountRecord {
  id: string;
  owner_user_id: string;
  tier: "free" | "creator" | "studio";
  status: "active" | "suspended";
}

export interface ApiKeyAuthOk {
  apiKey: ApiKeyRecord;
  account: AccountRecord;
  /** Service-role client (RLS-bypassing). Owner checks MUST be by account_id. */
  supabase: SupabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing types — implemented by api/v1/_shared/pricing.ts priceRequest().
// ─────────────────────────────────────────────────────────────────────────────

export interface PriceQuote {
  /** Credits to deduct for this request (always priced to the worst rung). */
  credits: number;
  /** USD figure the credit price was derived from, for reconciliation. */
  worst_rung_usd: number;
  margin_multiplier: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error envelope (frozen): { error: { code, message, request_id } }.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: { code: string; message: string; request_id: string };
}

/** Generate a per-request id (used in error envelopes + log correlation). */
export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

/**
 * Build a JSON error Response with the frozen envelope + CORS headers.
 * Mirrors the throw-a-Response convention used by requireAdmin/requireApiKey.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  origin: string | null,
  requestId?: string,
): Response {
  const body: ApiErrorBody = {
    error: { code, message, request_id: requestId ?? newRequestId() },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

/** Build a JSON success Response with CORS headers + no-store. */
export function apiJson(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}
