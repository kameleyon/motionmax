import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { writeSystemLog } from "../_shared/log.ts";

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch active subscription to get Stripe customer ID
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id, stripe_subscription_id, status")
      .eq("user_id", user.id)
      .maybeSingle();

    // Cancel Stripe subscription before any data deletion so Stripe
    // doesn't continue charging a deleted customer
    if (sub?.stripe_subscription_id && sub.status === "active") {
      const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
      if (stripeKey) {
        const stripe = new Stripe(stripeKey, { apiVersion: "2024-12-18.acacia" });
        try {
          await stripe.subscriptions.cancel(sub.stripe_subscription_id);
          console.log(`Cancelled Stripe subscription ${sub.stripe_subscription_id} for user ${user.id}`);
        } catch (stripeErr) {
          // Log but don't block deletion — subscription may already be cancelled
          console.error(`Stripe cancellation failed for ${sub.stripe_subscription_id}:`, stripeErr);
        }
      } else {
        console.warn("STRIPE_SECRET_KEY not set — skipping Stripe cancellation");
      }
    }

    // Insert into deletion_requests; the nightly cron will process it after
    // the 7-day grace period (GDPR Art. 17)
    const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { error: insertError } = await supabaseAdmin
      .from("deletion_requests")
      .insert({
        user_id: user.id,
        email: user.email,
        status: "pending",
        scheduled_at: scheduledAt,
      });

    if (insertError) {
      console.error("Failed to create deletion request:", insertError);
      return new Response(JSON.stringify({ error: "Failed to schedule account deletion" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Account deletion scheduled for user ${user.id} at ${scheduledAt}`);

    await writeSystemLog({
      supabase: supabaseAdmin,
      category: "user_activity",
      event_type: "user.account_deletion_requested",
      userId: user.id,
      message: `Account deletion scheduled for ${user.email ?? user.id}`,
      details: { scheduled_at: scheduledAt, hadActiveSubscription: sub?.status === "active" },
    });

    return new Response(
      JSON.stringify({ success: true, scheduled_at: scheduledAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Delete-account error:", error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
serve(handler);
