import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { packAddonSkuToCredits } from "../_shared/stripeProducts.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
});

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[UPDATE-PACK-QUANTITY] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = "UserFacingError"; }
}

const VALID_QUANTITIES = new Set([1, 2, 4, 10]);

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
      key: "update-pack-quantity", maxRequests: 5, windowSeconds: 60, userId: user.id,
    });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    const body = await req.json().catch(() => ({}));
    const requestedQuantity = Number(body?.quantity);
    if (!VALID_QUANTITIES.has(requestedQuantity)) {
      throw new UserFacingError("Quantity must be 1, 2, 4, or 10");
    }

    // Look up subscription
    const { data: sub } = await supabaseClient
      .from("subscriptions")
      .select("stripe_subscription_id, pack_subscription_item_id, plan_name")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (!sub?.stripe_subscription_id) {
      throw new UserFacingError("No active Stripe subscription. Pick a plan first.");
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", { apiVersion: "2024-12-18.acacia" });

    // qty=1 means remove the add-on entirely (delete the SI if present)
    if (requestedQuantity === 1) {
      if (sub.pack_subscription_item_id) {
        try {
          await stripe.subscriptionItems.del(sub.pack_subscription_item_id);
          logStep("Deleted pack add-on subscription item", { siId: sub.pack_subscription_item_id });
        } catch (e) {
          logStep("Failed to delete SI (continuing)", { error: String(e) });
        }
      }
      await supabaseClient
        .from("subscriptions")
        .update({ pack_quantity: 1, pack_subscription_item_id: null })
        .eq("user_id", user.id);
      return new Response(JSON.stringify({ ok: true, quantity: 1 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }

    // Determine target add-on price by plan + interval
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const baseItem = stripeSub.items.data[0];
    const isYearly = baseItem.price?.recurring?.interval === "year";
    const planKey = (sub.plan_name === "studio" || sub.plan_name === "professional") ? "studio" : "creator";
    const sku = `pack_addon_${planKey}_${isYearly ? "yearly" : "monthly"}`;

    // Find the add-on price by lookup_key (set by the creation script)
    const prices = await stripe.prices.list({ lookup_keys: [sku], active: true, limit: 1 });
    const addonPrice = prices.data[0];
    if (!addonPrice) {
      throw new UserFacingError(
        `Pack add-on price not yet provisioned (sku=${sku}). Run scripts/stripe-create-billing-products.ts first.`,
      );
    }

    // Quantity above 1 is sold as additional units (qty - 1) on the
    // pack add-on SI. The base plan already includes 1 pack worth.
    const addonQuantity = requestedQuantity - 1;

    let siId: string | null = sub.pack_subscription_item_id;
    if (!siId) {
      // Create new SI
      const newSi = await stripe.subscriptionItems.create({
        subscription: sub.stripe_subscription_id,
        price: addonPrice.id,
        quantity: addonQuantity,
        proration_behavior: "create_prorations",
      });
      siId = newSi.id;
      logStep("Created pack add-on SI", { siId, addonQuantity });
    } else {
      await stripe.subscriptionItems.update(siId, {
        quantity: addonQuantity,
        proration_behavior: "create_prorations",
      });
      logStep("Updated pack add-on SI", { siId, addonQuantity });
    }

    await supabaseClient
      .from("subscriptions")
      .update({ pack_quantity: requestedQuantity, pack_subscription_item_id: siId })
      .eq("user_id", user.id);

    // Sanity-check the SKU is one of the configured add-ons
    if (!packAddonSkuToCredits[sku]) {
      logStep("WARNING: unknown SKU", { sku });
    }

    return new Response(JSON.stringify({ ok: true, quantity: requestedQuantity, sku }), {
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
