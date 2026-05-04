/**
 * Shared transient-error classifier for all worker services.
 *
 * A "transient" error is one that may succeed on a subsequent attempt:
 * network resets, timeouts, rate limits, and upstream gateway errors.
 * A "permanent" error (auth failure, bad request, etc.) should not be retried.
 *
 * Import `isTransientError` from this module instead of duplicating the
 * pattern list in individual service files.
 */

const TRANSIENT_PATTERNS: RegExp[] = [
  // Network-level errors
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EHOSTUNREACH/i,
  /socket hang up/i,
  /fetch failed/i,
  /network socket/i,
  /connection reset/i,
  /read ECONNRESET/i,

  // Rate-limiting
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /quota exceeded/i,

  // Upstream gateway / availability
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /request timeout/i,
  /upstream timeout/i,
  /temporarily unavailable/i,

  // Postgres / Supabase transient DB errors. statement_timeout shows up
  // when a heavy SELECT (e.g. generations join + huge scenes jsonb) runs
  // past the configured cap under contention; a short wait + retry
  // usually clears it without operator intervention.
  /canceling statement due to statement timeout/i,
  /statement timeout/i,
  /\b57014\b/, // Postgres SQLSTATE for query_canceled
  /could not serialize access/i, // SQLSTATE 40001 — serialization failure
];

/**
 * Returns true if the error is likely transient and the operation should be retried.
 *
 * Checks both `message` and `cause` (Node 16+ error chaining) so wrapped
 * fetch errors like "TypeError: fetch failed" + "cause: ECONNRESET" are caught.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return TRANSIENT_PATTERNS.some((p) => p.test(String(err)));
  }
  const text =
    err.message +
    (err.cause instanceof Error
      ? ` ${err.cause.message}`
      : err.cause
      ? ` ${String(err.cause)}`
      : "");
  return TRANSIENT_PATTERNS.some((p) => p.test(text));
}

/**
 * Returns the recommended delay (ms) before a retry, given the attempt count.
 * Uses exponential back-off with a 25% jitter band to spread concurrent retries.
 *
 * @param attempt   0-based attempt index (0 = first retry)
 * @param baseMs    Base delay in ms (default 2000)
 * @param maxMs     Cap on delay (default 30000)
 */
export function retryDelayMs(
  attempt: number,
  baseMs = 2_000,
  maxMs = 30_000,
): number {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.min(Math.max(baseMs, exp + jitter), maxMs);
}

/**
 * Run a Supabase query with up to `attempts` total tries when the error
 * is transient (statement timeout, serialization failure, connection
 * blip). Use ONLY for read-style queries that are safe to re-run; do
 * not wrap mutations that aren't idempotent.
 *
 * The wrapped function should return `{ data, error }` shaped like
 * `await supabase.from(...)...`. We classify via the standard
 * `isTransientError` so adding a new pattern above cascades here.
 */
// Supabase's PostgrestBuilder is PromiseLike, not a strict Promise — we
// accept either so callsites can pass the chain directly without
// awaiting first. The return type R is whatever the caller's chain
// resolves to (preserves Supabase's narrow `{ data: T; error: null }
// | { data: null; error: PostgrestError }` discriminated union).
export async function retryDbRead<R extends { data: unknown; error: { message: string } | null }>(
  fn: () => PromiseLike<R>,
  attempts = 3,
  baseMs = 1_000,
): Promise<R> {
  let last = await fn();
  for (let i = 0; i < attempts - 1; i++) {
    if (!last.error) return last;
    // Supabase returns PostgrestError as a plain object, not an Error
    // instance, so route the message string through the classifier
    // directly to make sure the regex patterns are tested.
    if (!isTransientError(new Error(last.error.message))) return last;
    await new Promise((r) => setTimeout(r, retryDelayMs(i, baseMs, 8_000)));
    last = await fn();
  }
  return last;
}
