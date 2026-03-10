import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "https://motionmax.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-CHECKOUT] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
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

    const { priceId, mode } = await req.json();
    if (!priceId) throw new Error("Price ID is required");

    // Validate against known price IDs to prevent purchase of unintended products
    const VALID_PRICE_IDS = new Set([
      "price_1SqN1x6hfVkBDzkSzfLDk9eF", "price_1T2b0Q6hfVkBDzkSF4MqHPRi", // starter monthly/yearly
      "price_1SqN2D6hfVkBDzkS6ywVTBEt", "price_1T2b0R6hfVkBDzkSFD5gowGz", // creator monthly/yearly
      "price_1SqN2U6hfVkBDzkSNCDvRyeP", "price_1T2b0S6hfVkBDzkS4nrYAc2E", // professional monthly/yearly
      "price_1SuJk36hfVkBDzkSCbSorQJY", "price_1SqN2q6hfVkBDzkSNbEXBWTL", // credit 15 / 50
      "price_1SqN316hfVkBDzkSVq77cGDd", "price_1SuJk46hfVkBDzkSSkkal5QG", // credit 150 / 500
    ]);
    if (!VALID_PRICE_IDS.has(priceId)) throw new Error("Invalid price ID");

    logStep("Request params", { priceId, mode });

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2025-08-27.basil",
    });

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
