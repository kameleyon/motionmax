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
