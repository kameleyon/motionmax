/**
 * Consolidated error message utilities.
 * Merges auth-specific and general error message mapping into one module.
 * Both functions convert technical error messages to user-friendly strings.
 */

const LOG = "[ErrorMessages]";

/**
 * Map raw Supabase Auth error messages to user-friendly strings.
 * Use for login, signup, password reset, and other auth flows.
 */
export function getAuthErrorMessage(raw: string | undefined): string {
  if (!raw) {
    console.warn(LOG, "getAuthErrorMessage called with empty input");
    return "Something went wrong. Please try again.";
  }

  const msg = raw.toLowerCase();
  console.log(LOG, "Mapping auth error:", raw);

  // Duplicate / existing user
  if (msg.includes("user already registered") || msg.includes("already been registered")) {
    return "An account with this email already exists. Try signing in instead.";
  }

  // Invalid credentials
  if (msg.includes("invalid login credentials") || msg.includes("invalid_credentials")) {
    return "Incorrect email or password. Please try again.";
  }

  // Weak password
  if (msg.includes("password") && (msg.includes("weak") || msg.includes("at least") || msg.includes("too short"))) {
    return "Your password is too weak. Use at least 6 characters with a mix of letters and numbers.";
  }

  // Email not confirmed
  if (msg.includes("email not confirmed") || msg.includes("not confirmed")) {
    return "Please verify your email address before signing in. Check your inbox for a confirmation link.";
  }

  // Rate limited
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429")) {
    return "Too many attempts. Please wait a moment and try again.";
  }

  // Invalid email format
  if (msg.includes("invalid email") || msg.includes("unable to validate email")) {
    return "Please enter a valid email address.";
  }

  // Network errors
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("timeout")) {
    return "Connection issue. Please check your internet and try again.";
  }

  // Same password as before (update flow)
  if (msg.includes("same password") || msg.includes("different password")) {
    return "New password must be different from your current password.";
  }

  // Fallback — if the raw message is short and non-technical, use it as-is
  if (raw.length < 80 && !raw.includes("{") && !raw.includes("_")) {
    return raw;
  }

  console.warn(LOG, "Auth error fell through to generic fallback:", raw);
  return "Something went wrong. Please try again.";
}

/**
 * Convert technical error messages to user-friendly messages.
 * Use for generation, export, and other non-auth operational errors.
 */
export function getUserFriendlyErrorMessage(error: string | undefined): string {
  if (!error) {
    console.warn(LOG, "getUserFriendlyErrorMessage called with empty input");
    return "Something went wrong. Please try again.";
  }

  const lowerError = error.toLowerCase();
  console.log(LOG, "Mapping operational error:", error);

  // Network/connection errors
  if (lowerError.includes("failed to fetch") || lowerError.includes("network")) {
    return "Connection interrupted. Please check your internet and try again.";
  }

  // Timeout errors
  if (lowerError.includes("timeout") || lowerError.includes("timed out")) {
    return "The request took too long. Please try again.";
  }

  // Session/auth errors
  if (lowerError.includes("session expired") || lowerError.includes("not signed in") || lowerError.includes("401")) {
    return "Your session has expired. Please refresh the page and sign in again.";
  }

  // Rate limit errors
  if (lowerError.includes("rate limit") || lowerError.includes("429") || lowerError.includes("too many")) {
    return "Too many requests. Please wait a moment and try again.";
  }

  // Credits errors
  if (lowerError.includes("credits") || lowerError.includes("402")) {
    return "Insufficient credits. Please add more credits to continue.";
  }

  // Interrupted/stale generation
  if (lowerError.includes("interrupted") || lowerError.includes("was interrupted")) {
    return "This generation was interrupted. Please try again.";
  }

  // High demand / service unavailable
  if (lowerError.includes("high demand") || lowerError.includes("unavailable") || lowerError.includes("e003")) {
    return "The service is experiencing high demand. Please try again in a moment.";
  }

  // Generic server errors
  if (lowerError.includes("500") || lowerError.includes("server error") || lowerError.includes("internal")) {
    return "A server error occurred. Please try again in a moment.";
  }

  // If the error is already user-friendly, return as-is
  if (!lowerError.includes("error") && error.length < 100 && !error.includes("_") && !error.includes("{")) {
    return error;
  }

  console.warn(LOG, "Operational error fell through to generic fallback:", error);
  return "Something went wrong. Please try again.";
}
