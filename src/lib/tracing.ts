/**
 * Lightweight trace-ID propagation for end-to-end correlation.
 *
 * A trace ID ties the three disconnected Sentry traces together:
 *   1. Frontend (React) — Sentry browser transaction
 *   2. Edge function — Supabase/Deno
 *   3. Worker — Node.js on Render
 *
 * Usage:
 *   import { generateTraceId, withTrace } from "@/lib/tracing";
 *
 *   // When creating a job:
 *   const traceId = generateTraceId();
 *   await callEdgeFunction(payload, { "X-Trace-Id": traceId });
 *
 *   // Pass traceId to the job payload so the worker can pick it up.
 */

import * as Sentry from "@sentry/react";

/** Generate a new UUID v4 trace ID. */
export function generateTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Start a Sentry span for a generation job and return the trace ID to
 * propagate downstream (edge function → worker).
 *
 * The span is keyed by `traceId` so Sentry can correlate it with worker traces
 * that carry the same value.
 */
export function startGenerationTrace(
  operation: string,
  traceId: string,
): () => void {
  const span = Sentry.startInactiveSpan({
    name: operation,
    attributes: { "motionmax.trace_id": traceId },
  });
  return () => span.end();
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
