import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
};

/**
 * Stable product IDs — these rarely change in Stripe unlike price IDs.
 * Validation checks that the requested price belongs to one of these products.
 */
const VALID_PRODUCT_IDS = new Set([
  "prod_Tnyz2nMLqpHz3R", // Starter
  "prod_Tnz0KUQX2J5VBH", // Creator
  "prod_Tnz0BeRmJDdh0V", // Professional
  "prod_Ts3r9EBXzzKKfU", // Credit 15
  "prod_Tnz0B2aJPD895y", // Credit 50
  "prod_Tnz1CygtJnMhUz", // Credit 150
  "prod_Ts3rl1zDT9oLVt", // Credit 500
]);

serve(async (req) => {
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
    if (userError) throw new Error(`Authentication error: ${userError.message}`);

    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

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
    if (!priceId) throw new Error("Price ID is required");

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

    // Dynamic validation: fetch the price from Stripe and verify it is active
    // and belongs to one of our known products (product IDs are stable).
    const price = await stripe.prices.retrieve(priceId);
    if (!price || !price.active) {
      throw new Error("Price is no longer active. Please refresh and try again.");
    }

    const productId = typeof price.product === "string" ? price.product : price.product?.id;
    if (!productId || !VALID_PRODUCT_IDS.has(productId)) {
      throw new Error("Invalid product for this price");
    }

    logStep("Price validated", { priceId, productId, active: price.active });

    // Check for existing Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Found existing customer", { customerId });
    }

    const origin = req.headers.get("origin") || "https://motionmax.io";

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      mode: mode || "subscription",
      success_url: `${origin}/usage?success=true`,
      cancel_url: `${origin}/pricing?canceled=true`,
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
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
