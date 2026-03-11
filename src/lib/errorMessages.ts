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

  // Invalid credentials — wrong email or password
  if (
    msg.includes("invalid login credentials") ||
    msg.includes("invalid_credentials") ||
    msg.includes("wrong password") ||
    msg.includes("incorrect password") ||
    msg.includes("password is incorrect") ||
    msg.includes("email or password") ||
    msg.includes("invalid email or password")
  ) {
    return "Incorrect email or password. Please double-check and try again.";
  }

  // User not found (Supabase may return this in some flows)
  if (msg.includes("user not found") || msg.includes("no user found")) {
    return "No account found with that email. Did you mean to sign up?";
  }

  // Weak password
  if (msg.includes("password") && (msg.includes("weak") || msg.includes("at least") || msg.includes("too short") || msg.includes("characters"))) {
    return "Password must be at least 8 characters long.";
  }

  // Email not confirmed
  if (msg.includes("email not confirmed") || msg.includes("not confirmed") || msg.includes("email_not_confirmed")) {
    return "Please verify your email address before signing in. Check your inbox (and spam folder) for a confirmation link.";
  }

  // Rate limited
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("429") || msg.includes("email rate limit")) {
    return "Too many attempts. Please wait a few minutes before trying again.";
  }

  // Invalid email format
  if (msg.includes("invalid email") || msg.includes("unable to validate email") || msg.includes("valid email")) {
    return "Please enter a valid email address.";
  }

  // Network errors
  if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("timeout") || msg.includes("fetch error")) {
    return "Connection issue. Please check your internet and try again.";
  }

  // Same password as before (update flow)
  if (msg.includes("same password") || msg.includes("different password") || msg.includes("should be different")) {
    return "Your new password must be different from your current password.";
  }

  // Token / link expired
  if (msg.includes("token") && (msg.includes("expired") || msg.includes("invalid"))) {
    return "This link has expired. Please request a new one.";
  }

  // Signup disabled
  if (msg.includes("signup") && msg.includes("disabled")) {
    return "New sign-ups are temporarily disabled. Please try again later.";
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
