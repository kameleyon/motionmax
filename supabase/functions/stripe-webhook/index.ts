import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

// Credit pack product IDs - Updated pricing
const creditPackProducts: Record<string, number> = {
  "prod_TqznJ5NkfAEdUY": 15,   // 15 credits - $11.99
  "prod_TqznSfnDazIjj2": 50,   // 50 credits - $34.99
  "prod_Tqznn5NHeJnhS6": 150,  // 150 credits - $89.99
  "prod_Tqznoknz2TmraQ": 500,  // 500 credits - $249.99
  // Legacy packs (keep for existing purchases)
  "prod_TnzLJDYSV45eEF": 10,   // 10 credits (legacy)
  "prod_TnzL0a9nwvoZKm": 50,   // 50 credits (legacy)
  "prod_TnzL2ewLWIt1hD": 150,  // 150 credits (legacy)
};

// Subscription plan product IDs - Updated tiers
const subscriptionProducts: Record<string, string> = {
  "prod_TqznNZmUhevHh4": "starter",
  "prod_TqznlgT1Jl6Re7": "creator",
  "prod_TqznqQYYG4UUY8": "professional",
  // Legacy plans (keep for existing subscriptions)
  "prod_TnzLdHWPkqAiqr": "starter",   // old premium -> starter
  "prod_TnzLCasreSakEb": "creator",    // old pro -> creator
  "prod_TnzLP4tQINtak9": "professional", // old platinum -> professional
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2025-08-27.basil",
  });

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const signature = req.headers.get("stripe-signature");
    const body = await req.text();
    
    logStep("Webhook received", { hasSignature: !!signature });

    // Verify webhook signature for security
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      logStep("ERROR", { message: "Webhook secret not configured" });
      return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    if (!signature) {
      logStep("ERROR", { message: "No signature provided" });
      return new Response(JSON.stringify({ error: "No signature provided" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    let event: Stripe.Event;
    try {
      // In Deno/WebCrypto environments, Stripe requires the async variant.
      event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      logStep("ERROR", { message: `Signature verification failed: ${errorMessage}` });
      return new Response(JSON.stringify({ error: "Signature verification failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    logStep("Event verified and parsed", { type: event.type });

    // === IDEMPOTENCY CHECK: Skip already-processed events ===
    const { data: existingEvent } = await supabaseAdmin
      .from("webhook_events")
      .select("id")
      .eq("event_id", event.id)
      .maybeSingle();

    if (existingEvent) {
      logStep("Duplicate event, skipping", { eventId: event.id });
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // Record event as processed BEFORE handling to prevent race conditions
    await supabaseAdmin
      .from("webhook_events")
      .insert({ event_id: event.id, event_type: event.type });

    logStep("Event recorded for idempotency", { eventId: event.id });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id || session.client_reference_id;
        const customerId = session.customer as string;
        
        logStep("Checkout completed", { userId, customerId, mode: session.mode });

        if (!userId) {
          logStep("No user ID found in session");
          break;
        }

        if (session.mode === "payment") {
          // One-time payment (credit purchase)
          const paymentIntentId = session.payment_intent as string;

          // === DEDUP CHECK: Prevent duplicate credit grants for same payment ===
          if (paymentIntentId) {
            const { data: existingTx } = await supabaseAdmin
              .from("credit_transactions")
              .select("id")
              .eq("stripe_payment_intent_id", paymentIntentId)
              .maybeSingle();

            if (existingTx) {
              logStep("Credits already granted for this payment, skipping", { paymentIntentId });
              break;
            }
          }

          const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
          for (const item of lineItems.data) {
            const productId = item.price?.product as string;
            const credits = creditPackProducts[productId];
            
            if (credits) {
              logStep("Adding credits", { userId, credits, productId });
              
              // Use atomic RPC to safely increment credits
              await supabaseAdmin.rpc("increment_user_credits", {
                p_user_id: userId,
                p_credits: credits,
              });

              // Log the transaction
              await supabaseAdmin
                .from("credit_transactions")
                .insert({
                  user_id: userId,
                  amount: credits,
                  transaction_type: "purchase",
                  description: `Purchased ${credits} credits`,
                  stripe_payment_intent_id: paymentIntentId,
                });
            }
          }
        } else if (session.mode === "subscription") {
          // Subscription purchase
          const subscriptionId = session.subscription as string;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const productId = subscription.items.data[0].price.product as string;
          const planName = subscriptionProducts[productId] || "starter";

          logStep("Creating subscription record", { userId, planName, subscriptionId });

          // Upsert subscription
          const { data: existingSub } = await supabaseAdmin
            .from("subscriptions")
            .select("*")
            .eq("user_id", userId)
            .single();

          const subscriptionData = {
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan_name: planName,
            status: "active" as const,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          };

          if (existingSub) {
            await supabaseAdmin
              .from("subscriptions")
              .update(subscriptionData)
              .eq("user_id", userId);
          } else {
            await supabaseAdmin
              .from("subscriptions")
              .insert(subscriptionData);
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        
        logStep("Subscription updated", { subscriptionId: subscription.id, status: subscription.status });

        // Find user by customer ID
        const { data: subData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (subData) {
          const productId = subscription.items.data[0].price.product as string;
          const planName = subscriptionProducts[productId] || "starter";

          // Map Stripe status to our status
          // Handle past_due specially - we want to track this
          let dbStatus = subscription.status as any;
          
          await supabaseAdmin
            .from("subscriptions")
            .update({
              plan_name: planName,
              status: dbStatus,
              current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
              current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
              cancel_at_period_end: subscription.cancel_at_period_end,
            })
            .eq("stripe_customer_id", customerId);

          // If subscription is past_due, log it for tracking
          if (subscription.status === "past_due") {
            logStep("Subscription past_due - user will be notified", { 
              userId: subData.user_id, 
              customerId 
            });
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        
        logStep("Invoice payment failed", { invoiceId: invoice.id, customerId });

        // Update subscription status to past_due if not already
        const { data: subData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id, status")
          .eq("stripe_customer_id", customerId)
          .single();

        if (subData && subData.status === "active") {
          await supabaseAdmin
            .from("subscriptions")
            .update({ status: "past_due" })
            .eq("stripe_customer_id", customerId);
          
          logStep("Subscription marked as past_due due to payment failure", { 
            userId: subData.user_id 
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        
        logStep("Subscription deleted", { subscriptionId: subscription.id });

        await supabaseAdmin
          .from("subscriptions")
          .update({
            status: "canceled",
            plan_name: "free",
          })
          .eq("stripe_customer_id", customerId);
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
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
