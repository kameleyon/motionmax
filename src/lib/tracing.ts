/**
 * Lightweight trace-ID propagation for end-to-end correlation.
 *
 * A trace ID ties the three disconnected Sentry traces together:
 *   1. Frontend (React) — Sentry browser transaction
 *   2. Edge function — Supabase/Deno
 *   3. Worker — Node.js on Render
 *
 * Audit C-9-6 wired this for real. Every `supabase.functions.invoke(...)`
 * callsite now uses `invokeWithTrace(...)` which:
 *   • generates a UUIDv4 BEFORE invoking the edge function,
 *   • passes the ID in both `X-Trace-Id` header AND `_trace_id` body field
 *     (the supabase-js client doesn't currently forward custom headers
 *     reliably across all transports — body is the belt-and-suspenders
 *     path the worker already reads via job.payload.traceId),
 *   • returns the trace ID alongside the data/error so the caller can
 *     surface it in a toast ("Reference: 1234abcd…") for actionable
 *     support tickets.
 */

import * as Sentry from "@sentry/react";
import { supabase } from "@/integrations/supabase/client";

/** Generate a new UUID v4 trace ID. */
export function generateTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Format a trace ID as a short, support-ticket-friendly reference. We expose
 * only the leading 8 hex chars — enough to disambiguate in Sentry search
 * (collision probability ~1 in 4 B) and short enough to ask a user to dictate
 * over the phone without typos.
 */
export function shortTraceRef(traceId: string): string {
  if (!traceId) return "";
  const hex = traceId.replace(/-/g, "");
  return hex.slice(0, 8);
}

/**
 * Start a Sentry span for a generation job and return the trace ID to
 * propagate downstream (edge function → worker).
 *
 * The span is keyed by `traceId` so Sentry can correlate it with worker traces
 * that carry the same value. The returned tuple includes an `end()` to close
 * the span when the pipeline completes / errors.
 */
export function startGenerationTrace(
  operation: string,
  traceId?: string,
): { traceId: string; end: () => void } {
  const id = traceId ?? generateTraceId();
  const span = Sentry.startInactiveSpan({
    name: operation,
    attributes: { "motionmax.trace_id": id },
  });
  Sentry.setTag("trace_id", id);
  return { traceId: id, end: () => span.end() };
}

/**
 * Attach the trace ID to a fetch Headers object.
 * Call before every edge-function request that starts or continues a job.
 */
export function attachTraceHeader(
  headers: HeadersInit | undefined,
  traceId: string,
): Record<string, string> {
  const existing =
    headers instanceof Headers
      ? Object.fromEntries(headers.entries())
      : (headers as Record<string, string>) ?? {};
  return { ...existing, "X-Trace-Id": traceId };
}

/**
 * Supabase functions.invoke wrapped with trace-id propagation.
 *
 * Audit C-9-6: every edge-function call MUST carry a trace ID so failed
 * requests can be reproduced end-to-end across browser → edge → worker.
 *
 * Behaviour:
 *   • Generates a UUIDv4 trace ID before invoking (or reuses one supplied
 *     via `options.traceId`).
 *   • Passes the ID via the `X-Trace-Id` header.
 *   • Mirrors the ID into the body as `_trace_id` so edge functions that
 *     proxy the body into a worker job payload (the common case via
 *     `submitJob`) propagate it automatically.
 *   • On error, attaches the trace ID to Sentry as a tag + scope context
 *     so the captured exception is searchable by trace.
 *   • Returns `{ data, error, traceId }` — callers should surface the
 *     `traceId` in error toasts via `shortTraceRef(traceId)`.
 */
type InvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "POST" | "GET" | "PUT" | "PATCH" | "DELETE";
  /** Optional pre-generated trace ID (e.g. when the caller is mid-pipeline). */
  traceId?: string;
};

export async function invokeWithTrace<T = unknown>(
  fnName: string,
  options: InvokeOptions = {},
): Promise<{ data: T | null; error: unknown; traceId: string }> {
  const traceId = options.traceId ?? generateTraceId();
  const headers = {
    ...(options.headers ?? {}),
    "X-Trace-Id": traceId,
  };
  // Mirror into body so edge functions that store the payload into a
  // worker job pass it along without extra header plumbing.
  let body = options.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    body = { ...body, _trace_id: traceId };
  } else if (body === undefined) {
    body = { _trace_id: traceId };
  }

  try {
    const result = await supabase.functions.invoke<T>(fnName, {
      ...(options.method ? { method: options.method } : {}),
      headers,
      body,
    });
    if (result.error) {
      Sentry.withScope((scope) => {
        scope.setTag("trace_id", traceId);
        scope.setTag("edge_function", fnName);
        scope.setContext("trace", { trace_id: traceId, function: fnName });
        Sentry.captureException(result.error);
      });
    }
    return {
      data: (result.data ?? null) as T | null,
      error: result.error ?? null,
      traceId,
    };
  } catch (err) {
    Sentry.withScope((scope) => {
      scope.setTag("trace_id", traceId);
      scope.setTag("edge_function", fnName);
      scope.setContext("trace", { trace_id: traceId, function: fnName });
      Sentry.captureException(err);
    });
    return { data: null, error: err, traceId };
  }
}
