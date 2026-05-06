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

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * Stable product IDs — these rarely change in Stripe unlike price IDs.
 * Validation checks that the requested price belongs to one of these products.
 */
const VALID_PRODUCT_IDS = new Set([
  // Current products
  "prod_UHakcDFbS7Vw7z", // Creator
  "prod_UHakOYLBpnWBj8", // Studio / Professional
  "prod_UHalTrTNeIhUNX", // Credits 300
  "prod_UHalEgw5TyQdFM", // Credits 900
  "prod_UHalwIOINit7zr", // Credits 2500
  // Legacy products (kept for existing subscribers)
  "prod_Tnyz2nMLqpHz3R", // Starter (legacy)
  "prod_Tnz0KUQX2J5VBH", // Creator (legacy)
  "prod_Tnz0BeRmJDdh0V", // Professional (legacy)
  "prod_Ts3r9EBXzzKKfU", // Credit 15 (legacy)
  "prod_Tnz0B2aJPD895y", // Credit 50 (legacy)
  "prod_Tnz1CygtJnMhUz", // Credit 150 (legacy)
  "prod_Ts3rl1zDT9oLVt", // Credit 500 (legacy)
]);

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    logStep("Function started");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new UserFacingError("Authentication failed. Please sign in again.");

    const user = userData.user;
    if (!user?.email) throw new UserFacingError("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id });

    // Rate limit
    const rateLimitResult = await checkRateLimit(supabaseClient, {
      key: "create-checkout",
      maxRequests: 5,
      windowSeconds: 60,
      userId: user?.id,
    });
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 429,
      });
    }

    const { priceId, mode } = await req.json();
    if (!priceId) throw new UserFacingError("Price ID is required");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2024-12-18.acacia",
    });

    // Dynamic validation: fetch the price from Stripe and verify it is active
    // and belongs to one of our known products (product IDs are stable),
    // OR has `metadata.motionmax_sku` set (the new 2026-05-06 SKU catalog
    // created by scripts/stripe-create-billing-products.ts).
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    if (!price || !price.active) {
      throw new UserFacingError("Price is no longer active. Please refresh and try again.");
    }

    const productId = typeof price.product === "string" ? price.product : price.product?.id;
    const productMeta = typeof price.product === "object" && price.product !== null
      ? (price.product as { metadata?: Record<string, string> }).metadata ?? {}
      : {};
    const hasMotionmaxSku = !!productMeta.motionmax_sku;

    if (!productId || (!VALID_PRODUCT_IDS.has(productId) && !hasMotionmaxSku)) {
      throw new UserFacingError("Invalid product for this price");
    }

    logStep("Price validated", { priceId, productId, active: price.active, sku: productMeta.motionmax_sku });

    // Check for existing Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Found existing customer");
    }

    const origin = req.headers.get("origin") || "https://motionmax.io";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode || "subscription",
      success_url: `${origin}/billing?success=true`,
      cancel_url: `${origin}/billing?canceled=true`,
      metadata: {
        user_id: user.id,
      },
    });

    logStep("Checkout session created", { sessionId: session.id });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    const clientMessage = error instanceof UserFacingError
      ? errorMessage
      : "An unexpected error occurred. Please try again.";
    return new Response(JSON.stringify({ error: clientMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
}
serve(handler);
