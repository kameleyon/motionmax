/**
 * Rate limiting utility for Supabase Edge Functions
 * Uses Supabase database as distributed rate limit store
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";

interface RateLimitConfig {
  /** Unique identifier for this rate limit (e.g., "create-checkout", "export-data") */
  key: string;
  /** Maximum requests allowed in the window */
  maxRequests: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional: IP address for IP-based limiting */
  ip?: string;
  /** Optional: User ID for user-based limiting */
  userId?: string;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  error?: string;
}

/**
 * Check and enforce rate limiting using database
 */
export async function checkRateLimit(
  supabase: SupabaseClient,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const { key, maxRequests, windowSeconds, ip, userId } = config;

  // Create composite key: function_name:identifier
  const identifier = userId || ip || "anonymous";
  const rateLimitKey = `${key}:${identifier}`;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowSeconds * 1000);

  try {
    // Check if rate_limits table exists, create if not
    const { data: existingRequests, error: queryError } = await supabase
      .from("rate_limits")
      .select("id, created_at")
      .eq("key", rateLimitKey)
      .gte("created_at", windowStart.toISOString())
      .order("created_at", { ascending: false });

    if (queryError) {
      // If table doesn't exist, log and allow (fail open)
      console.error("[RateLimit] Query error:", queryError);
      return {
        allowed: true,
        remaining: maxRequests,
        resetAt: new Date(now.getTime() + windowSeconds * 1000),
        error: "Rate limit check failed",
      };
    }

    const requestCount = existingRequests?.length || 0;

    if (requestCount >= maxRequests) {
      // Rate limit exceeded
      const oldestRequest = existingRequests[existingRequests.length - 1];
      const resetAt = new Date(
        new Date(oldestRequest.created_at).getTime() + windowSeconds * 1000
      );

      return {
        allowed: false,
        remaining: 0,
        resetAt,
      };
    }

    // Record this request
    await supabase.from("rate_limits").insert({
      key: rateLimitKey,
      user_id: userId || null,
      ip_address: ip || null,
    });

    return {
      allowed: true,
      remaining: maxRequests - requestCount - 1,
      resetAt: new Date(now.getTime() + windowSeconds * 1000),
    };
  } catch (err) {
    // Fail open on errors to prevent blocking legitimate requests
    console.error("[RateLimit] Unexpected error:", err);
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: new Date(now.getTime() + windowSeconds * 1000),
      error: "Rate limit check failed",
    };
  }
}

/**
 * Return rate limit headers for HTTP response
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.remaining + (result.allowed ? 1 : 0)),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": result.resetAt.toISOString(),
  };
}

/**
 * Cleanup old rate limit records (call periodically via cron)
 */
export async function cleanupRateLimits(supabase: SupabaseClient, olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
  await supabase
    .from("rate_limits")
    .delete()
    .lt("created_at", cutoff.toISOString());
}
