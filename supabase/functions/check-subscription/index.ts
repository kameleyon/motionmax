import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

export async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(origin);
  }

  // Service role client for DB operations
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new Error("No authorization header provided");
    }

    const token = authHeader.replace("Bearer ", "");

    // Verify the JWT using the admin client
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      const msg = userError?.message?.toLowerCase() ?? "";
      if (msg.includes("expired") || msg.includes("jwt") || msg.includes("token")) {
        logStep("Token expired, returning 401");
        return new Response(JSON.stringify({ error: "Token expired", code: "TOKEN_EXPIRED" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 401,
        });
      }
      throw new Error("Authentication error: Invalid session");
    }

    const userId = user.id;
    const userEmail = user.email as string;

    if (!userId || !userEmail) {
      throw new Error("User not authenticated or email not available");
    }
    logStep("User authenticated", { userId, email: userEmail });

    // Rate limit (non-privileged — failure falls through to allow)
    const rateLimitResult = await checkRateLimit(supabaseAdmin, {
      key: "check-subscription",
      maxRequests: 30,
      windowSeconds: 60,
      userId,
    });
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 429,
      });
    }

    // Get credits balance (always needed)
    const { data: creditData } = await supabaseAdmin
      .from("user_credits")
      .select("credits_balance")
      .eq("user_id", userId)
      .single();

    const creditsBalance = creditData?.credits_balance || 0;

    // Check for manual/enterprise subscriptions first
    const { data: dbSubscription } = await supabaseAdmin
      .from("subscriptions")
      .select("plan_name, status, current_period_end, cancel_at_period_end, is_manual_subscription")
      .eq("user_id", userId)
      .eq("status", "active")
      .single();

    if (dbSubscription?.is_manual_subscription) {
      logStep("Found manual enterprise subscription", {
        plan: dbSubscription.plan_name,
        subscriptionEnd: dbSubscription.current_period_end,
      });
      return new Response(JSON.stringify({
        subscribed: true,
        plan: dbSubscription.plan_name,
        subscription_status: "active",
        subscription_end: dbSubscription.current_period_end,
        cancel_at_period_end: dbSubscription.cancel_at_period_end || false,
        credits_balance: creditsBalance,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Attempt Stripe lookup — if key is absent or Stripe fails, fall back to DB data
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) {
      logStep("STRIPE_SECRET_KEY not configured, returning DB subscription data");
      return buildDbFallbackResponse(corsHeaders, dbSubscription, creditsBalance);
    }

    let plan = "free";
    let subscriptionEnd: string | null = null;
    let cancelAtPeriodEnd = false;

    try {
      const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
      const customers = await stripe.customers.list({ email: userEmail, limit: 1 });

      if (customers.data.length === 0) {
        logStep("No Stripe customer found, returning free tier");
        return new Response(JSON.stringify({
          subscribed: false,
          plan: "free",
          credits_balance: creditsBalance,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        });
      }

      const customerId = customers.data[0].id;
      logStep("Found Stripe customer", { customerId });

      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
        limit: 1,
      });

      if (subscriptions.data.length > 0) {
        const subscription = subscriptions.data[0];

        const periodEndRaw =
          subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;

        const parseStripePeriodEndToIso = (value: unknown): string | null => {
          const n =
            typeof value === "number"
              ? value
              : typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))
                ? Number(value)
                : null;
          if (n === null) return null;
          const ms = n > 100_000_000_000 ? n : n * 1000;
          const d = new Date(ms);
          if (Number.isNaN(d.getTime())) return null;
          return d.toISOString();
        };

        subscriptionEnd = parseStripePeriodEndToIso(periodEndRaw);
        cancelAtPeriodEnd = subscription.cancel_at_period_end || false;

        const productRaw = subscription.items.data[0].price.product;
        const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
        logStep("Active subscription found", { subscriptionId: subscription.id, productId });

        const productToPlan: Record<string, string> = {
          "prod_Tnyz2nMLqpHz3R": "starter",
          "prod_Tnz0KUQX2J5VBH": "creator",
          "prod_Tnz0BeRmJDdh0V": "professional",
          "prod_TqznNZmUhevHh4": "starter",
          "prod_TqznlgT1Jl6Re7": "creator",
          "prod_TqznqQYYG4UUY8": "professional",
          "prod_TnzLdHWPkqAiqr": "starter",
          "prod_TnzLCasreSakEb": "creator",
          "prod_TnzLP4tQINtak9": "professional",
        };
        plan = productToPlan[productId] || "free";
      }
    } catch (stripeErr) {
      // Stripe is unavailable or erroring — return DB subscription data rather than 503
      logStep("Stripe lookup failed, falling back to DB data", {
        error: stripeErr instanceof Error ? stripeErr.message : String(stripeErr),
      });
      return buildDbFallbackResponse(corsHeaders, dbSubscription, creditsBalance);
    }

    logStep("Returning subscription status", { plan, subscriptionEnd });

    return new Response(JSON.stringify({
      subscribed: plan !== "free",
      plan,
      subscription_status: plan !== "free" ? (cancelAtPeriodEnd ? "canceling" : "active") : null,
      subscription_end: subscriptionEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
      credits_balance: creditsBalance,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });

    const lowerMsg = errorMessage.toLowerCase();
    if (lowerMsg.includes("jwt") || lowerMsg.includes("expired") || lowerMsg.includes("token")) {
      return new Response(JSON.stringify({ error: "Token expired", code: "TOKEN_EXPIRED" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    return new Response(JSON.stringify({
      error: errorMessage,
      code: "EDGE_FUNCTION_ERROR",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 503,
    });
  }
}
serve(handler);

export function buildDbFallbackResponse(
  corsHeaders: Record<string, string>,
  dbSubscription: { plan_name: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean } | null,
  creditsBalance: number,
): Response {
  if (!dbSubscription) {
    return new Response(JSON.stringify({
      subscribed: false,
      plan: "free",
      subscription_status: null,
      subscription_end: null,
      cancel_at_period_end: false,
      credits_balance: creditsBalance,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  }
  return new Response(JSON.stringify({
    subscribed: true,
    plan: dbSubscription.plan_name,
    subscription_status: dbSubscription.cancel_at_period_end ? "canceling" : "active",
    subscription_end: dbSubscription.current_period_end,
    cancel_at_period_end: dbSubscription.cancel_at_period_end || false,
    credits_balance: creditsBalance,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 200,
  });
}
