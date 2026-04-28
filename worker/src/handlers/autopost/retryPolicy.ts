/**
 * Retry policy for autopost publish jobs.
 *
 * Three attempts max:
 *   attempt 1 — immediate
 *   attempt 2 — +60s
 *   attempt 3 — +5 min
 * After 3 attempts we give up (return null) and mark the publish job
 * failed.
 */

/** Maximum number of attempts a publish job is allowed before being marked failed. */
export const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * How long to wait before the *next* attempt, given how many attempts have
 * already been made.
 *
 * @param attemptsSoFar - number of attempts already completed (0-based: 0
 *                       means none yet, 1 means one already tried, etc.)
 * @returns delay in ms, or null if no more attempts should be made.
 */
export function retryDelayMs(attemptsSoFar: number): number | null {
  if (attemptsSoFar <= 0) return 0; // first try, immediate
  if (attemptsSoFar === 1) return 60_000;
  if (attemptsSoFar === 2) return 5 * 60_000;
  return null; // give up
}

export interface ErrorClassification {
  /** Stable string code we persist into autopost_publish_jobs.error_code. */
  code: string;
  /** Whether the dispatcher should attempt another try (subject to attempt budget). */
  retryable: boolean;
}

/**
 * Map an HTTP status + response body into our retry decision.
 *
 *   401 -> token_expired (retry once after refresh)
 *   403 -> forbidden / scope (not retryable; the human must reconnect)
 *   429 -> rate_limited (retryable; caller honors Retry-After if set)
 *   5xx -> server_error (retryable)
 *   4xx other -> client_error (not retryable)
 *   null  -> network_error (retryable; transient connectivity)
 */
export function classifyError(httpStatus: number | null, body: string | object): ErrorClassification {
  void body; // body inspection is platform-specific; Wave 3a will use it.

  if (httpStatus === null || httpStatus === undefined) {
    return { code: "network_error", retryable: true };
  }

  if (httpStatus === 401) return { code: "token_expired", retryable: true };
  if (httpStatus === 403) return { code: "forbidden", retryable: false };
  if (httpStatus === 429) return { code: "rate_limited", retryable: true };

  if (httpStatus >= 500 && httpStatus <= 599) {
    return { code: "server_error", retryable: true };
  }

  if (httpStatus >= 400 && httpStatus <= 499) {
    return { code: "client_error", retryable: false };
  }

  // 1xx/2xx/3xx shouldn't reach this code path, but be safe.
  return { code: "unknown_error", retryable: false };
}

/**
 * Parse a Retry-After header value (seconds OR HTTP date) into ms.
 * Returns null if the value can't be parsed.
 */
export function parseRetryAfterMs(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  // First try integer seconds.
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.floor(asInt * 1000);
  }
  // Otherwise try HTTP date.
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
