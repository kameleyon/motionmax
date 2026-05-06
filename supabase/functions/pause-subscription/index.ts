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
  console.log(`[PAUSE-SUBSCRIPTION] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = "UserFacingError"; }
}

const VALID_MONTHS = new Set([1, 2, 3]);

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
      key: "pause-subscription", maxRequests: 5, windowSeconds: 60, userId: user.id,
    });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    const body = await req.json().catch(() => ({}));
    const months = Number(body?.months ?? 0);
    const resume = !!body?.resume;

    if (!resume && !VALID_MONTHS.has(months)) {
      throw new UserFacingError("months must be 1, 2, or 3");
    }

    const { data: sub } = await supabaseClient
      .from("subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!sub?.stripe_subscription_id) throw new UserFacingError("No active subscription");
    if (sub.stripe_subscription_id.startsWith("manual_")) {
      throw new UserFacingError(
        "This account is on a manual / comp subscription. Pause is only available for paid Stripe subscriptions — contact support.",
      );
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2024-12-18.acacia" });

    if (resume) {
      await stripe.subscriptions.update(sub.stripe_subscription_id, { pause_collection: "" as unknown as null });
      await supabaseClient.from("subscriptions").update({ paused_until: null }).eq("user_id", user.id);
      return new Response(JSON.stringify({ ok: true, resumed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    const resumeAt = new Date();
    resumeAt.setUTCMonth(resumeAt.getUTCMonth() + months);

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: { behavior: "void", resumes_at: Math.floor(resumeAt.getTime() / 1000) },
    });

    await supabaseClient
      .from("subscriptions")
      .update({ paused_until: resumeAt.toISOString() })
      .eq("user_id", user.id);

    logStep("Subscription paused", { months, resumeAt });
    return new Response(JSON.stringify({ ok: true, paused_until: resumeAt.toISOString() }), {
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
