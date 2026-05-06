import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
});

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CANCEL-WITH-REASON] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = "UserFacingError"; }
}

/**
 * cancel-with-reason
 * ============================================================
 * Two modes:
 *   - keep_with_offer = true:
 *       Apply the RETAIN50 coupon to the customer's subscription
 *       (50% off for the next 3 months) and DO NOT cancel.
 *       Records the reason + kept_with_offer=true.
 *   - keep_with_offer = false (default):
 *       Schedule cancellation at period end (cancel_at_period_end)
 *       and record the reason. The customer can still un-cancel
 *       in the Stripe portal until the period ends.
 *
 * Body: { reason?: string, keep_with_offer?: boolean }
 */
export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new UserFacingError("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new UserFacingError("Authentication failed. Please sign in again.");
    const user = userData.user;
    if (!user) throw new UserFacingError("User not authenticated");

    const rl = await checkRateLimit(supabaseClient, {
      key: "cancel-with-reason", maxRequests: 5, windowSeconds: 60, userId: user.id,
    });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    const body = await req.json().catch(() => ({}));
    const reason = (body?.reason as string | undefined)?.slice(0, 200) ?? null;
    const keepWithOffer = !!body?.keep_with_offer;

    const { data: sub } = await supabaseClient
      .from("subscriptions")
      .select("stripe_subscription_id, stripe_customer_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!sub?.stripe_subscription_id) throw new UserFacingError("No active subscription");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2024-12-18.acacia" });

    if (keepWithOffer) {
      // Apply RETAIN50 coupon (50% off for 3 months — created by the
      // stripe-create-billing-products.ts script).
      try {
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          coupon: "RETAIN50",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logStep("Coupon application failed", { error: msg });
        throw new UserFacingError("Could not apply retention discount: " + msg);
      }

      await supabaseClient.from("cancellation_reasons").insert({
        user_id: user.id, reason, kept_with_offer: true,
      });

      logStep("Retention offer applied", { userId: user.id });
      return new Response(JSON.stringify({ ok: true, kept_with_offer: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // Schedule cancellation at period end
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    await supabaseClient
      .from("subscriptions")
      .update({ cancel_at_period_end: true })
      .eq("user_id", user.id);

    await supabaseClient.from("cancellation_reasons").insert({
      user_id: user.id, reason, kept_with_offer: false,
    });

    logStep("Subscription scheduled to cancel", { userId: user.id });
    return new Response(JSON.stringify({ ok: true, cancel_at_period_end: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    const clientMessage = error instanceof UserFacingError ? errorMessage : "An unexpected error occurred.";
    return new Response(JSON.stringify({ error: clientMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500,
    });
  }
}

serve(handler);
