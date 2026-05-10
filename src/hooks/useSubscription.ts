import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTabVisible } from "@/hooks/useTabVisible";
import { trackEvent, getStoredUtm } from "@/hooks/useAnalytics";
import {
  PLAN_LIMITS,
  getCreditsRequired,
  validateGenerationAccess,
  normalizePlanName,
  type PlanTier,
  type ValidationResult
} from "@/lib/planLimits";
import { createScopedLogger } from "@/lib/logger";
import { isLikelyEUUser, EUCoolingOffConsentRequired } from "@/lib/euCoolingOff";
import { invokeWithTrace, shortTraceRef } from "@/lib/tracing";

const log = createScopedLogger("Subscription");

// Re-export Stripe IDs from the centralised config so existing imports
// (`import { STRIPE_PLANS } from "@/hooks/useSubscription"`) keep working.
export { STRIPE_PLANS, CREDIT_PACKS } from "@/config/stripeProducts";

// Re-export for convenience
export { PLAN_LIMITS, getCreditsRequired, validateGenerationAccess };
export type { PlanTier, ValidationResult };

export interface SubscriptionState {
  subscribed: boolean;
  plan: PlanTier;
  subscriptionStatus: "active" | "canceling" | "past_due" | "unpaid" | "canceled" | null;
  subscriptionEnd: string | null;
  cancelAtPeriodEnd: boolean;
  creditsBalance: number;
  _fetchFailed?: true;
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

    const normalizedPlan = normalizePlanName(sub.plan_name || "free");

    return {
      subscribed: true,
      plan: normalizedPlan,
      subscriptionStatus: sub.cancel_at_period_end ? "canceling" : "active",
      subscriptionEnd: sub.current_period_end || null,
      cancelAtPeriodEnd: sub.cancel_at_period_end || false,
      creditsBalance: credits,
    };
  } catch (err) {
    log.error("DB fallback also failed, using free defaults", err);
    return { ...FREE_STATE, _fetchFailed: true };
  }
}

function parseResponse(d: Record<string, unknown>): SubscriptionState {
  return {
    subscribed: (d.subscribed as boolean) || false,
    plan: normalizePlanName((d.plan as string) || "free"),
    subscriptionStatus: ((d.subscription_status as string) || (d.subscribed ? "active" : null)) as SubscriptionState["subscriptionStatus"],
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
    log.warn("Edge function unreachable, falling back to DB");
    return fetchSubscriptionFromDB();
  }

  // Check if response body contains error details (data may have error info even with error set)
  const responseCode = (data?.code as string) || "";
  const responseError = (data?.error as string) || "";
  const errMsg = (error as { message?: string })?.message || "";

  // Token expired → refresh and retry once
  const isTokenExpired =
    responseCode === "TOKEN_EXPIRED" ||
    responseError.includes("Token expired") ||
    errMsg.includes("401");

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
      if (!retryError && retryData) return parseResponse(retryData);
    } catch (err) {
      log.warn("Subscription retry failed:", err);
    }
    return fetchSubscriptionFromDB();
  }

  // Any edge function error → DB fallback (not a security issue: RLS protects the data)
  if (error) {
    log.debug("check-subscription edge fn unavailable, using DB fallback", { code: responseCode, detail: responseError || errMsg });
    return fetchSubscriptionFromDB();
  }

  return parseResponse(data!);
}

export function useSubscription() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  // C-5-6 (Prism PERF-010): pause the 60s subscription poll when the
  // tab is hidden. The user-supabase-functions edge call to
  // /functions/v1/check-subscription is one of the more expensive
  // hops in the dashboard fan-out (cold-start can be 800ms+).
  const tabVisible = useTabVisible();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: SUBSCRIPTION_QUERY_KEY,
    queryFn: () => fetchSubscription(session?.access_token),
    enabled: !!session?.access_token,
    staleTime: 60_000, // Consider data fresh for 60 seconds
    gcTime: 5 * 60_000, // Keep in cache for 5 minutes
    // Conditional poll — drop to `false` when tab is hidden so the
    // timer stops entirely (no scheduled-then-skipped ticks).
    refetchInterval: tabVisible ? 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false, // Avoid extra calls on tab switch
    retry: 1, // Only retry once on failure
  });

  // Manual refresh function
  const checkSubscription = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const createCheckout = useCallback(async (
    priceId: string,
    mode: "subscription" | "payment" = "subscription",
    options?: { euCoolingOffWaived?: boolean },
  ) => {
    if (!session?.access_token) {
      throw new Error("Please sign in to continue");
    }

    // EU/EEA/UK Directive 2011/83/EU Art. 16(m): for digital services, the
    // consumer keeps a 14-day right of withdrawal UNLESS they have given
    // explicit prior consent to immediate performance AND acknowledged loss
    // of the withdrawal right. We surface a consent checkbox in the UI
    // (Pricing/TabPlans/landing). If a caller forgets to wire it through,
    // throw a typed error so the UI can prompt rather than silently bypass.
    const euCoolingOffWaived = options?.euCoolingOffWaived === true;
    if (isLikelyEUUser() && !euCoolingOffWaived) {
      throw new EUCoolingOffConsentRequired();
    }

    // Audit C-9-6: invokeWithTrace generates an X-Trace-Id + _trace_id so
    // Stripe Checkout failures can be reproduced end-to-end (browser →
    // create-checkout edge fn → Stripe). Combined with C-9-2's
    // tracesSampleRate=1.0 on create-checkout, every failed checkout has
    // a full distributed trace in Sentry tagged by trace_id.
    const { data, error, traceId } = await invokeWithTrace<{ url?: string }>(
      "create-checkout",
      {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { priceId, mode, eu_cooling_off_waived: euCoolingOffWaived },
      },
    );

    if (error) {
      const msg = error instanceof Error ? error.message : "Checkout failed";
      throw new Error(`${msg} (Ref: ${shortTraceRef(traceId)})`);
    }
    if (!data?.url) {
      throw new Error(
        `Failed to create checkout session (Ref: ${shortTraceRef(traceId)})`,
      );
    }

    // Wave C Lens M-referral: surface the active referral code so the
    // funnel report can break out signups-by-referrer all the way to
    // paid conversion. Auth.tsx sets this on landing-with-?ref=...
    // (REF_SESSION_KEY = "mm_referral_code"). Missing = direct.
    let referralCode: string | undefined;
    try {
      const stored = sessionStorage.getItem("mm_referral_code");
      if (stored && stored.length > 0 && stored.length < 64) referralCode = stored;
    } catch { /* sessionStorage may be unavailable in incognito */ }

    try {
      trackEvent("begin_checkout", {
        price_id: priceId,
        mode,
        ...getStoredUtm(),
        ...(referralCode ? { referral_code: referralCode } : {}),
      });
      // Audit asked for both paid_plan_selected (intent) and
      // checkout_completed (server-confirmed). Intent fires here because
      // we have the user's plan choice and we've just successfully
      // minted the Checkout URL. Completion fires on the success-page
      // bounce — but include referral_code on both so we can compute
      // per-channel conversion lift without joining tables.
      if (mode === "subscription") {
        trackEvent("paid_plan_selected", {
          price_id: priceId,
          ...(referralCode ? { referral_code: referralCode } : {}),
        });
      }
    } catch { /* analytics non-critical */ }

    // Wave C Lens M2 — mobile same-tab redirect.
    //
    // Stripe Checkout opened in a new tab on mobile is a UX trap: iOS
    // Safari and Chrome on Android shove the user into a tab they can't
    // see, the original tab becomes a dangling "click to come back"
    // surface, and on PWAs the new tab opens in the system browser —
    // breaking the back-button flow entirely. Stripe's own guidance is
    // to use top-level navigation on mobile.
    //
    // Detection: matchMedia is the cleanest signal we have (no UA
    // parsing). 768 px matches Tailwind's `md` breakpoint which our
    // pricing surface already uses as the desktop boundary. On the
    // server / non-DOM environment we fall through to window.open.
    const isMobile =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches;

    if (isMobile) {
      window.location.href = data.url;
    } else {
      window.open(data.url, "_blank");
    }
    return data.url;
  }, [session?.access_token]);

  const openCustomerPortal = useCallback(async () => {
    if (!session?.access_token) {
      throw new Error("Please sign in to continue");
    }

    // Audit C-9-6: trace-propagated invoke so customer-portal failures are
    // attributable when a user reports "billing portal won't load."
    const { data, error, traceId } = await invokeWithTrace<{
      url?: string;
      error?: string;
      message?: string;
    }>("customer-portal", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (error) {
      const msg = error instanceof Error ? error.message : "Billing portal failed";
      throw new Error(`${msg} (Ref: ${shortTraceRef(traceId)})`);
    }

    if (data?.error === "MANUAL_SUBSCRIPTION") {
      throw new Error(data.message || "Your subscription is managed directly. Please contact support for billing inquiries.");
    }

    if (!data?.url) {
      throw new Error(
        `Failed to open billing portal (Ref: ${shortTraceRef(traceId)})`,
      );
    }

    window.open(data.url, "_blank");
    return data.url;
  }, [session?.access_token]);

  // Invalidate subscription cache (useful after checkout completes)
  const invalidateSubscription = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_QUERY_KEY });
  }, [queryClient]);

  const fetchError = data?._fetchFailed
    ? "Unable to verify subscription. Some features may be limited."
    : null;

  return {
    subscribed: data?.subscribed ?? false,
    plan: data?.plan ?? "free",
    subscriptionStatus: data?.subscriptionStatus ?? null,
    subscriptionEnd: data?.subscriptionEnd ?? null,
    cancelAtPeriodEnd: data?.cancelAtPeriodEnd ?? false,
    creditsBalance: data?.creditsBalance ?? 0,
    isLoading,
    error: error instanceof Error ? error.message : null,
    fetchError,
    checkSubscription,
    createCheckout,
    openCustomerPortal,
    invalidateSubscription,
  };
}
