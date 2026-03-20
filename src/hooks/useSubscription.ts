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

// Fetch function for React Query
async function fetchSubscription(accessToken: string | undefined): Promise<SubscriptionState> {
  if (!accessToken) {
    return {
      subscribed: false,
      plan: "free",
      subscriptionStatus: null,
      subscriptionEnd: null,
      cancelAtPeriodEnd: false,
      creditsBalance: 0,
    };
  }

  const { data, error } = await supabase.functions.invoke("check-subscription", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  // Handle token expiration - supabase.functions.invoke puts non-2xx responses
  // in error with message like "Edge Function returned a non-2xx status code"
  // and the response body may be in data or need parsing from error context
  const isTokenExpired =
    error?.message?.includes("401") ||
    error?.message?.toLowerCase().includes("non-2xx") ||
    data?.code === "TOKEN_EXPIRED" ||
    data?.error?.includes?.("Token expired");

  if (isTokenExpired) {
    const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !refreshData.session) {
      // Session is truly dead — sign out to trigger redirect to /auth
      await supabase.auth.signOut();
      return {
        subscribed: false,
        plan: "free" as const,
        subscriptionStatus: null,
        subscriptionEnd: null,
        cancelAtPeriodEnd: false,
        creditsBalance: 0,
      };
    }
    // Retry with refreshed token
    const { data: retryData, error: retryError } = await supabase.functions.invoke("check-subscription", {
      headers: {
        Authorization: `Bearer ${refreshData.session.access_token}`,
      },
    });
    if (retryError) throw retryError;
    return {
      subscribed: retryData.subscribed || false,
      plan: retryData.plan || "free",
      subscriptionStatus: retryData.subscription_status || (retryData.subscribed ? "active" : null),
      subscriptionEnd: retryData.subscription_end || null,
      cancelAtPeriodEnd: retryData.cancel_at_period_end || false,
      creditsBalance: retryData.credits_balance || 0,
    };
  }

  if (error) throw error;

  return {
    subscribed: data.subscribed || false,
    plan: data.plan || "free",
    subscriptionStatus: data.subscription_status || (data.subscribed ? "active" : null),
    subscriptionEnd: data.subscription_end || null,
    cancelAtPeriodEnd: data.cancel_at_period_end || false,
    creditsBalance: data.credits_balance || 0,
  };
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
