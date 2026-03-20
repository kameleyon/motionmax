/**
 * Structured error handling utilities for the application.
 * Classifies errors and extracts safe, user-friendly messages.
 */

import { AuthError } from "@supabase/supabase-js";

/** Recognized error categories */
export type ErrorCategory = "auth" | "network" | "validation" | "database" | "unknown";

interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  technical: string;
}

/** Patterns that indicate a network-level failure */
const NETWORK_PATTERNS = [
  "failed to fetch",
  "network request failed",
  "networkerror",
  "load failed",
  "timeout",
  "econnrefused",
  "enotfound",
  "aborted",
];

/** Patterns that indicate an auth failure */
const AUTH_PATTERNS = [
  "jwt expired",
  "session expired",
  "invalid refresh token",
  "not authenticated",
  "invalid login credentials",
  "email not confirmed",
];

/**
 * Extract a string message from an unknown error value.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "An unexpected error occurred";
}

/**
 * Classify an error into a category and provide safe messaging.
 */
export function classifyError(error: unknown): ClassifiedError {
  const technical = extractErrorMessage(error);
  const lower = technical.toLowerCase();

  // Supabase AuthError
  if (error instanceof AuthError) {
    return {
      category: "auth",
      message: getAuthMessage(technical),
      technical,
    };
  }

  // Auth pattern match
  if (AUTH_PATTERNS.some(p => lower.includes(p))) {
    return {
      category: "auth",
      message: getAuthMessage(technical),
      technical,
    };
  }

  // Network errors
  if (NETWORK_PATTERNS.some(p => lower.includes(p))) {
    return {
      category: "network",
      message: "Connection lost. Please check your internet and try again.",
      technical,
    };
  }

  // Database / constraint errors (from Supabase PostgREST)
  if (lower.includes("duplicate key") || lower.includes("violates") || lower.includes("constraint")) {
    return {
      category: "database",
      message: "This action conflicts with existing data. Please try again.",
      technical,
    };
  }

  // Validation errors (typically thrown by our own code)
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("must be")) {
    return {
      category: "validation",
      message: technical, // Our own validation messages are already user-friendly
      technical,
    };
  }

  return {
    category: "unknown",
    message: "Something went wrong. Please try again.",
    technical,
  };
}

/**
 * Get a user-friendly auth error message.
 */
function getAuthMessage(technical: string): string {
  const lower = technical.toLowerCase();
  if (lower.includes("invalid login credentials")) return "Invalid email or password.";
  if (lower.includes("email not confirmed")) return "Please confirm your email before signing in.";
  if (lower.includes("expired") || lower.includes("refresh token")) return "Session expired. Please sign in again.";
  if (lower.includes("rate limit")) return "Too many attempts. Please wait a moment.";
  return "Authentication error. Please try again.";
}

/**
 * Safe toast-friendly error extraction. Use instead of `catch (error: any)`.
 *
 * @example
 * ```ts
 * try { ... }
 * catch (error) {
 *   toast.error(toSafeMessage(error));
 * }
 * ```
 */
export function toSafeMessage(error: unknown, fallback?: string): string {
  const classified = classifyError(error);
  return classified.message || fallback || "Please try again.";
}
