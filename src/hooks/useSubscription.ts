import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  PLAN_LIMITS,
  getCreditsRequired,
  validateGenerationAccess,
  type PlanTier,
  type ValidationResult
} from "@/lib/planLimits";
import { createScopedLogger } from "@/lib/logger";

const log = createScopedLogger("Subscription");

// Re-export Stripe IDs from the centralised config so existing imports
// (`import { STRIPE_PLANS } from "@/hooks/useSubscription"`) keep working.
export { STRIPE_PLANS, CREDIT_PACKS } from "@/config/stripeProducts";

// Re-export for convenience
export { PLAN_LIMITS, getCreditsRequired, validateGenerationAccess };
export type { PlanTier, ValidationResult };

// Helper to check if user can use character consistency feature
export function canUseCharacterConsistency(plan: PlanTier): boolean {
  return plan === "professional";
}

export interface SubscriptionState {
  subscribed: boolean;
  plan: PlanTier;
  subscriptionStatus: string | null;
  subscriptionEnd: string | null;
  cancelAtPeriodEnd: boolean;
  creditsBalance: number;
}

const SUBSCRIPTION_QUERY_KEY = ["subscription"] as const;

const FREE_STATE: SubscriptionState = {
  subscribed: false,
  plan: "free",
  subscriptionStatus: null,
  subscriptionEnd: null,
  cancelAtPeriodEnd: false,
  creditsBalance: 0,
};

/**
 * Direct DB fallback when the edge function is unreachable.
 * Queries the subscriptions + user_credits tables directly so users
 * keep their plan even if the edge function is temporarily down.
 * Never throws — returns FREE_STATE on any failure.
 */
async function fetchSubscriptionFromDB(): Promise<SubscriptionState> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return FREE_STATE;

    const [subResult, creditResult] = await Promise.all([
      supabase
        .from("subscriptions")
        .select("plan_name, status, current_period_end, cancel_at_period_end")
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle(),
      supabase
        .from("user_credits")
        .select("credits_balance")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    const sub = subResult.data;
    const credits = creditResult.data?.credits_balance ?? 0;

    if (!sub) {
      return { ...FREE_STATE, creditsBalance: credits };
    }

    return {
      subscribed: true,
      plan: (sub.plan_name as PlanTier) || "free",
      subscriptionStatus: sub.cancel_at_period_end ? "canceling" : "active",
      subscriptionEnd: sub.current_period_end || null,
      cancelAtPeriodEnd: sub.cancel_at_period_end || false,
      creditsBalance: credits,
    };
  } catch (err) {
    log.warn("DB fallback also failed, using free defaults", err);
    return FREE_STATE;
  }
}

function parseResponse(d: Record<string, unknown>): SubscriptionState {
  return {
    subscribed: (d.subscribed as boolean) || false,
    plan: (d.plan as PlanTier) || "free",
    subscriptionStatus: (d.subscription_status as string) || (d.subscribed ? "active" : null),
    subscriptionEnd: (d.subscription_end as string) || null,
    cancelAtPeriodEnd: (d.cancel_at_period_end as boolean) || false,
    creditsBalance: (d.credits_balance as number) || 0,
  };
}

/**
 * Check whether an error is a network-level failure (edge function unreachable).
 */
function isEdgeFunctionNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === "FunctionsFetchError" ||
    !!e.message?.includes("Failed to send") ||
    !!e.message?.includes("Failed to fetch") ||
    !!e.message?.includes("NetworkError")
  );
}

// Fetch function for React Query — never throws on network errors
async function fetchSubscription(accessToken: string | undefined): Promise<SubscriptionState> {
  if (!accessToken) return FREE_STATE;

  let data: Record<string, unknown> | null = null;
  let error: unknown = null;

  try {
    const result = await supabase.functions.invoke("check-subscription", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    data = result.data;
    error = result.error;
  } catch (thrown) {
    error = thrown;
  }

  // Edge function unreachable → fall back to direct DB query
  if (isEdgeFunctionNetworkError(error)) {
    log.warn("Edge function unreachable, falling back to DB query");
    return fetchSubscriptionFromDB();
  }

  // Handle token expiration specifically
  const errObj = error as { message?: string } | null;
  const isTokenExpired =
    errObj?.message?.includes("401") ||
    data?.code === "TOKEN_EXPIRED" ||
    (data?.error as string)?.includes?.("Token expired");

  if (isTokenExpired) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      await supabase.auth.signOut();
      return FREE_STATE;
    }
    try {
      const { data: retryData, error: retryError } = await supabase.functions.invoke("check-subscription", {
        headers: { Authorization: `Bearer ${refreshData.session.access_token}` },
      });
      if (isEdgeFunctionNetworkError(retryError)) return fetchSubscriptionFromDB();
      if (retryError) {
        // Retry also failed — fall back to DB instead of throwing
        log.warn("Subscription check retry failed, falling back to DB", retryError);
        return fetchSubscriptionFromDB();
      }
      return parseResponse(retryData);
    } catch (retryThrown) {
      log.warn("Subscription check retry threw, falling back to DB", retryThrown);
      return fetchSubscriptionFromDB();
    }
  }

  // Any other edge function error (non-2xx that isn't token-related) → fall back to DB
  if (error) {
    log.warn("Edge function returned error, falling back to DB", error);
    return fetchSubscriptionFromDB();
  }

  return parseResponse(data!);
}

export function useSubscription() {
  const { session } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: SUBSCRIPTION_QUERY_KEY,
    queryFn: () => fetchSubscription(session?.access_token),
    enabled: !!session?.access_token,
    staleTime: 60_000, // Consider data fresh for 60 seconds
    gcTime: 5 * 60_000, // Keep in cache for 5 minutes
    refetchInterval: 60_000, // Auto-refresh every 60 seconds when window is focused
    refetchOnWindowFocus: false, // Avoid extra calls on tab switch
    retry: 1, // Only retry once on failure
  });

  // Manual refresh function
  const checkSubscription = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const createCheckout = useCallback(async (priceId: string, mode: "subscription" | "payment" = "subscription") => {
    if (!session?.access_token) {
      throw new Error("Please sign in to continue");
    }

    const { data, error } = await supabase.functions.invoke("create-checkout", {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
      body: { priceId, mode },
    });

    if (error) throw error;
    if (!data?.url) throw new Error("Failed to create checkout session");

    window.open(data.url, "_blank");
    return data.url;
  }, [session?.access_token]);

  const openCustomerPortal = useCallback(async () => {
    if (!session?.access_token) {
      throw new Error("Please sign in to continue");
    }

    const { data, error } = await supabase.functions.invoke("customer-portal", {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (error) throw error;
    
    if (data?.error === "MANUAL_SUBSCRIPTION") {
      throw new Error(data.message || "Your subscription is managed directly. Please contact support for billing inquiries.");
    }
    
    if (!data?.url) throw new Error("Failed to open billing portal");

    window.open(data.url, "_blank");
    return data.url;
  }, [session?.access_token]);

  // Invalidate subscription cache (useful after checkout completes)
  const invalidateSubscription = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_QUERY_KEY });
  }, [queryClient]);

  return {
    subscribed: data?.subscribed ?? false,
    plan: data?.plan ?? "free",
    subscriptionStatus: data?.subscriptionStatus ?? null,
    subscriptionEnd: data?.subscriptionEnd ?? null,
    cancelAtPeriodEnd: data?.cancelAtPeriodEnd ?? false,
    creditsBalance: data?.creditsBalance ?? 0,
    isLoading,
    error: error instanceof Error ? error.message : null,
    checkSubscription,
    createCheckout,
    openCustomerPortal,
    invalidateSubscription,
  };
}
