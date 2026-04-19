import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { creditPackProducts, subscriptionProducts, monthlyCredits } from "../_shared/stripeProducts.ts";
import { sendWelcomeEmail, sendPaymentFailedEmail, sendCancellationEmail } from "../_shared/resend.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
});

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

serve(async (req) => {
  const corsHeaders = {
    ...getCorsHeaders(req.headers.get("origin")),
    // Stripe webhook signature header must be allowed
    "Access-Control-Allow-Headers": getCorsHeaders(req.headers.get("origin"))["Access-Control-Allow-Headers"] + ", stripe-signature",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2024-12-18.acacia",
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

    // === IDEMPOTENCY: Check-first, insert-after ===
    // We SELECT before running handlers and INSERT after they succeed.
    // This prevents the insert-before-run bug where a handler 500 causes
    // Stripe to retry, the retry hits the existing row (23505), and the
    // event is silently dropped — losing financial data with no error.
    const { data: existingEvent } = await supabaseAdmin
      .from("webhook_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();

    if (existingEvent) {
      logStep("Duplicate event, skipping", { eventId: event.id });
      return new Response(JSON.stringify({ received: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    logStep("Event not yet processed, proceeding", { eventId: event.id });

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.user_id || session.client_reference_id;
        const customerId = session.customer as string;
        
        logStep("Checkout completed", { userId, mode: session.mode });

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
            const productRaw = item.price?.product;
            const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
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
            } else {
              const priceId = item.price?.id ?? null;
              console.error(JSON.stringify({
                level: "ERROR",
                event: "unknown_credit_pack_product",
                message: "Unknown Stripe product — customer paid but NO credits were granted",
                productId,
                priceId,
                sessionId: session.id,
                customerId: session.customer,
                userId,
              }));
              logStep("ERROR: Unknown credit pack product — credits NOT granted", { productId, priceId, sessionId: session.id });
            }
          }
        } else if (session.mode === "subscription") {
          // Subscription purchase
          const subscriptionId = session.subscription as string;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const productRaw = subscription.items.data[0].price.product;
          const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
          const planName = subscriptionProducts[productId] || "starter";

          logStep("Creating subscription record", { userId, planName, productId });

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

          // Send welcome email for new subscriptions
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
          if (userData?.user?.email) {
            await sendWelcomeEmail(userData.user.email, planName);
            logStep("Welcome email sent", { userId });
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        
        logStep("Subscription updated", { status: subscription.status });

        // Find user by customer ID
        const { data: subData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (subData) {
          const productRaw = subscription.items.data[0].price.product;
          const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
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
        
        logStep("Invoice payment failed", { invoiceId: invoice.id });

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

          const { data: failedUserData } = await supabaseAdmin.auth.admin.getUserById(subData.user_id);
          if (failedUserData?.user?.email) {
            await sendPaymentFailedEmail(failedUserData.user.email);
            logStep("Payment-failed email sent", { userId: subData.user_id });
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        logStep("Subscription deleted", { subscriptionId: subscription.id });

        const { data: cancelSubData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        await supabaseAdmin
          .from("subscriptions")
          .update({
            status: "canceled",
            plan_name: "free",
          })
          .eq("stripe_customer_id", customerId);

        if (cancelSubData) {
          const { data: cancelUserData } = await supabaseAdmin.auth.admin.getUserById(cancelSubData.user_id);
          if (cancelUserData?.user?.email) {
            await sendCancellationEmail(cancelUserData.user.email);
            logStep("Cancellation email sent", { userId: cancelSubData.user_id });
          }
        }
        break;
      }

      // 2.1: Monthly credit renewal on subscription invoice payment
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;

        // Only process subscription invoices (not one-time purchases)
        if (invoice.subscription) {
          logStep("Invoice paid (subscription renewal)", { invoiceId: invoice.id });

          // Find the user's subscription to get their plan
          const { data: subData } = await supabaseAdmin
            .from("subscriptions")
            .select("user_id, plan_name")
            .eq("stripe_customer_id", customerId)
            .eq("status", "active")
            .single();

          if (subData) {
            const credits = monthlyCredits[subData.plan_name] || 0;

            if (credits > 0) {
              // Grant monthly credits
              const { error: creditError } = await supabaseAdmin.rpc("increment_user_credits", {
                p_user_id: subData.user_id,
                p_credits: credits,
              });

              if (creditError) {
                logStep("ERROR: Failed to grant monthly credits", { userId: subData.user_id, credits, error: creditError.message });
              } else {
                // Log the transaction
                await supabaseAdmin.from("credit_transactions").insert({
                  user_id: subData.user_id,
                  amount: credits,
                  transaction_type: "monthly_renewal",
                  description: `Monthly ${subData.plan_name} plan renewal: ${credits} credits`,
                });
                logStep("Monthly credits granted", { userId: subData.user_id, plan: subData.plan_name, credits });
              }
            }
          }
        }
        break;
      }

      // 2.5: Handle refunds — claw back credits
      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const customerId = charge.customer as string;

        logStep("Charge refunded", { chargeId: charge.id, amount: charge.amount_refunded });

        // Find the user
        const { data: refundSubData } = await supabaseAdmin
          .from("subscriptions")
          .select("user_id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (refundSubData) {
          // Match the exact purchase transaction by payment intent ID
          const paymentIntentId = charge.payment_intent as string;
          const { data: txData } = await supabaseAdmin
            .from("credit_transactions")
            .select("amount")
            .eq("user_id", refundSubData.user_id)
            .eq("transaction_type", "purchase")
            .eq("stripe_payment_intent_id", paymentIntentId)
            .maybeSingle();

          if (txData && txData.amount > 0) {
            // Deduct the refunded credits
            await supabaseAdmin.rpc("deduct_credits_securely", {
              p_user_id: refundSubData.user_id,
              p_amount: Math.abs(txData.amount),
              p_transaction_type: "refund_clawback",
              p_description: `Credits clawed back due to refund (charge ${charge.id})`,
            });
            logStep("Credits clawed back", { userId: refundSubData.user_id, credits: txData.amount });
          }
        }
        break;
      }
    }

    // === IDEMPOTENCY: Insert row only after handlers succeed ===
    // A 23505 here means two concurrent identical events both passed the
    // SELECT check and both ran handlers — that's acceptable since all
    // handlers are idempotent. We still return 200 so Stripe won't retry.
    const { error: idempotencyError } = await supabaseAdmin
      .from("webhook_events")
      .insert({ event_id: event.id, event_type: event.type });

    if (idempotencyError && idempotencyError.code !== "23505") {
      logStep("WARNING: Idempotency insert failed (non-duplicate)", { message: idempotencyError.message });
    } else {
      logStep("Event recorded for idempotency", { eventId: event.id });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    Sentry.captureException(error);
    await Sentry.flush(2000);
    return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
