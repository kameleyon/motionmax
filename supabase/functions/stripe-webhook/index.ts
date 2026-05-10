import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { creditPackProducts, subscriptionProducts, monthlyCredits, newTopupSkuToCredits, packAddonSkuToCredits } from "../_shared/stripeProducts.ts";
import { sendWelcomeEmail, sendPaymentFailedEmail, sendCancellationEmail, sendBrandedReceiptEmail } from "../_shared/resend.ts";
import { writeSystemLog } from "../_shared/log.ts";

/**
 * Map a Stripe event type → our SystemEventType. Centralized so a new
 * Stripe event drops in one place. Unknown types fall through to
 * `system.info` so we still get a row but don't pollute pay.* metrics.
 */
function eventTypeToSystem(stripeType: string): { event_type: string; category: "user_activity" | "system_info" | "system_error" } {
  switch (stripeType) {
    case "checkout.session.completed": return { event_type: "pay.checkout_created", category: "user_activity" };
    case "invoice.paid":                return { event_type: "pay.payment_succeeded", category: "user_activity" };
    case "invoice.payment_failed":      return { event_type: "pay.payment_failed", category: "system_error" };
    case "customer.subscription.updated":  return { event_type: "pay.subscription_renewed", category: "user_activity" };
    case "customer.subscription.deleted":  return { event_type: "pay.subscription_renewed", category: "user_activity" };
    case "charge.refunded":             return { event_type: "pay.refund_issued", category: "user_activity" };
    default: return { event_type: `pay.${stripeType.replace(/\./g, "_")}`, category: "system_info" };
  }
}
import * as Sentry from "https://deno.land/x/sentry/index.mjs";
import { scrubSentryEvent } from "../_shared/sentry-scrubber.ts";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
  // billing endpoints use full trace sampling per audit C-9-2 — every failed
  // checkout MUST be reproducible. Stripe webhooks fan out into subscription
  // lifecycle, credit grants, receipts, refunds; losing 90 % of traces here
  // makes "why didn't my upgrade succeed?" tickets unsolvable.
  tracesSampleRate: 1.0,
  beforeSend: scrubSentryEvent,
});

const maskId = (id: string | undefined | null): string => {
  if (!id) return '(none)';
  return id.length > 8 ? `${id.substring(0, 4)}...${id.slice(-4)}` : '***';
};

const logStep = (step: string, details?: any) => {
  // Mask Stripe customer IDs and user IDs before logging to avoid leaking PII in info-level logs
  const safeDetails = details ? JSON.parse(JSON.stringify(details, (key, value) => {
    if (typeof value === 'string' && (key === 'userId' || key === 'customerId' || key === 'customer' || key === 'client_id' || key === 'user_id')) {
      return maskId(value);
    }
    return value;
  })) : undefined;
  const detailsStr = safeDetails ? ` - ${JSON.stringify(safeDetails)}` : '';
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

async function trackConversion(params: {
  eventName: string;
  userId: string;
  value: number;
  currency: string;
  transactionId: string;
  itemName: string;
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any;
}): Promise<void> {
  const measurementId = Deno.env.get("GA_MEASUREMENT_ID");
  const apiSecret = Deno.env.get("GA_API_SECRET");
  if (!measurementId || !apiSecret) return;

  // §11 Lens C4 — resolve the GA4 client_id from profiles. Captured at
  // signup from the `_ga` cookie. Falls back to userId only when the
  // user signed up before the column existed or cookies were disabled
  // (legacy attribution is "(direct) / (none)" — same as the broken
  // path was producing before, but now constrained to the pre-fix
  // cohort only).
  let clientId = params.userId;
  let utmSource: string | null = null;
  let utmMedium: string | null = null;
  let utmCampaign: string | null = null;
  try {
    const { data: profile } = await params.supabaseAdmin
      .from("profiles")
      .select("ga_client_id, acquisition")
      .eq("user_id", params.userId)
      .maybeSingle();
    if (profile?.ga_client_id) {
      clientId = profile.ga_client_id;
    }
    // Forward stored UTMs as event params so the conversion is enriched
    // even if GA's own session stitching falls through (e.g. GA4 expired
    // the session before the user converted).
    const acq = profile?.acquisition as Record<string, unknown> | null;
    if (acq) {
      const pick = (k: string): string | null => {
        const v = acq[k];
        return typeof v === "string" && v.length > 0 ? v : null;
      };
      utmSource   = pick("utm_source");
      utmMedium   = pick("utm_medium");
      utmCampaign = pick("utm_campaign");
    }
  } catch (e) {
    logStep("GA4 client_id lookup failed (using userId fallback)", { error: String(e) });
  }

  try {
    const eventParams: Record<string, unknown> = {
      currency: params.currency,
      value: params.value,
      transaction_id: params.transactionId,
      items: [{ item_name: params.itemName, price: params.value }],
    };
    if (utmSource)   eventParams.campaign_source = utmSource;
    if (utmMedium)   eventParams.campaign_medium = utmMedium;
    if (utmCampaign) eventParams.campaign         = utmCampaign;

    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          // user_id stays the Supabase UUID so GA4's User-ID dimension
          // can stitch this hit to authenticated client-side events
          // (which were stamped with the same hashed UUID by
          // identifyUser() in useAnalytics.ts). client_id is the new
          // bit — it's the anonymous session id, not the user id.
          user_id: params.userId,
          events: [{
            name: params.eventName,
            params: eventParams,
          }],
        }),
      }
    );
  } catch (e) {
    logStep("GA4 tracking error (non-critical)", { error: String(e) });
  }
}

/**
 * Optional dependency-injection seam for tests (Probe F-10-03 / B-NEW-20).
 * Production code calls `handler(req)` and we construct Stripe + Supabase
 * from environment variables exactly as before. Tests call
 * `handler(req, { stripe, supabaseAdmin })` with controllable mocks so the
 * REAL handler logic — signature verification, idempotency, switch arms —
 * is exercised end-to-end instead of a mirrored copy in the test file.
 */
export interface WebhookDeps {
  // deno-lint-ignore no-explicit-any
  stripe?: any;
  // deno-lint-ignore no-explicit-any
  supabaseAdmin?: any;
}

export async function handler(req: Request, deps: WebhookDeps = {}): Promise<Response> {
  const corsHeaders = {
    ...getCorsHeaders(req.headers.get("origin")),
    // Stripe webhook signature header must be allowed
    "Access-Control-Allow-Headers": getCorsHeaders(req.headers.get("origin"))["Access-Control-Allow-Headers"] + ", stripe-signature",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const stripe = deps.stripe ?? new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2024-12-18.acacia",
  });

  const supabaseAdmin = deps.supabaseAdmin ?? createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // C-9-8: track the audit row's event_id at function scope so the
  // catch handler can flip status to "failed" without needing access to
  // the inner-scoped `event` variable.
  let reservedAuditEventId: string | null = null;

  try {
    // Guard against oversized webhook payloads before buffering the body.
    // Stripe webhooks are typically < 10 KB; cap at 512 KB.
    const MAX_BODY_BYTES = 512 * 1024;
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      logStep("ERROR", { message: `Payload too large: ${contentLength} bytes` });
      return new Response(JSON.stringify({ error: "Payload too large" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 413,
      });
    }

    const signature = req.headers.get("stripe-signature");
    const body = await req.text();

    if (body.length > MAX_BODY_BYTES) {
      logStep("ERROR", { message: `Body too large after read: ${body.length} bytes` });
      return new Response(JSON.stringify({ error: "Payload too large" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 413,
      });
    }
    
    logStep("Webhook received", { hasSignature: !!signature });

    // Verify webhook signature for security
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!webhookSecret) {
      logStep("ERROR", { message: "Webhook secret not configured" });
      Sentry.captureException(new Error("STRIPE_WEBHOOK_SECRET is not configured"));
      await Sentry.flush(2000);
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
      Sentry.captureMessage(`Stripe signature verification failed: ${errorMessage}`, { level: "warning" });
      await Sentry.flush(2000);
      return new Response(JSON.stringify({ error: "Signature verification failed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    logStep("Event verified and parsed", { type: event.type });

    // Audit C-9-6: tag every Sentry event with the Stripe event ID as the
    // trace_id. Combined with tracesSampleRate=1.0 (C-9-2) this means every
    // webhook is fully searchable in Sentry by its `evt_…` ID — the same ID
    // visible in the Stripe Dashboard and the `webhook_events` table.
    Sentry.setTag("trace_id", event.id);
    Sentry.setTag("stripe_event_type", event.type);

    // === C-9-8: AUDIT-FIRST WEBHOOK PROCESSING ===
    // SOC 2 CC7.2 and PCI-DSS 10.2 require that every privileged action
    // produces an audit row, and that the audit row IS the record of
    // record — billing mutations must not commit without one. Pre-fix,
    // we inserted webhook_events AFTER handlers ran (best-effort). A
    // crash between handler-commit and the audit insert would leave a
    // credit grant or subscription update on the books with no audit
    // row, which is a control failure.
    //
    // New ordering:
    //   1. UPSERT a "processing" row with event_id, type, body hash
    //      BEFORE running any handler.
    //   2. Run handlers.
    //   3. On success: UPDATE the row to "completed".
    //   4. On error:   UPDATE the row to "failed" with the error message.
    //   5. If the audit INSERT itself fails (DB outage etc.), refuse to
    //      process the webhook — return 500 so Stripe retries. Never
    //      run handlers without an audit row reserved.
    //
    // Idempotency: ON CONFLICT (event_id) on the insert means a retried
    // delivery hits the existing row. If that row is in "completed" or
    // "failed" state, return 200 (we already processed it).

    // Hash the raw request body for the audit row. Using SHA-256 hex
    // since the original body bytes shouldn't sit in plaintext audit
    // logs (PII concerns + size). Verified earlier via signature so
    // there's no integrity loss — the hash is just for forensic
    // correlation if we ever need to compare to Stripe's stored body.
    const _encoder = new TextEncoder();
    const _bodyHashBuf = await crypto.subtle.digest("SHA-256", _encoder.encode(body));
    const bodyHash = Array.from(new Uint8Array(_bodyHashBuf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Reserve audit row. The `status` and `body_hash` columns are
    // best-effort: if a deployment hasn't migrated them yet, those
    // keys are silently dropped by Supabase — the core event_id /
    // event_type columns are the long-standing idempotency anchors.
    const { data: existingAudit, error: auditInsertErr } = await supabaseAdmin
      .from("webhook_events")
      .upsert(
        {
          event_id: event.id,
          event_type: event.type,
          status: "processing",
          body_hash: bodyHash,
          received_at: new Date().toISOString(),
        },
        { onConflict: "event_id", ignoreDuplicates: false },
      )
      .select("event_id, status")
      .maybeSingle();

    if (auditInsertErr) {
      // Audit row reservation failed — DB outage, RLS misconfig, etc.
      // SOC 2 / PCI requires we refuse to run any business logic without
      // an audit row, so return 500 and let Stripe retry.
      logStep("CRITICAL: audit reservation failed — refusing to process", {
        eventId: event.id,
        error: auditInsertErr.message,
      });
      Sentry.captureException(new Error(`Stripe webhook audit reservation failed: ${auditInsertErr.message}`));
      await Sentry.flush(2000);
      return new Response(JSON.stringify({ error: "Audit log unavailable; please retry" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    // Duplicate check: if the row already existed in terminal state,
    // honor the idempotency contract and short-circuit.
    const previousStatus = (existingAudit as { status?: string } | null)?.status;
    if (previousStatus === "completed" || previousStatus === "failed") {
      logStep("Duplicate event (audit row already terminal), skipping", { eventId: event.id, previousStatus });
      return new Response(JSON.stringify({ received: true, duplicate: true, previousStatus }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    reservedAuditEventId = event.id;
    logStep("Audit row reserved, proceeding", { eventId: event.id });

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

          const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { expand: ["data.price.product"] });
          for (const item of lineItems.data) {
            const productRaw = item.price?.product;
            const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
            // Resolve credits via legacy product map first, then via the
            // new SKU map (read from product.metadata.motionmax_sku).
            let credits = creditPackProducts[productId];
            if (!credits) {
              const productObj = typeof productRaw === "object" && productRaw !== null ? productRaw as { metadata?: Record<string, string> } : null;
              const sku = productObj?.metadata?.motionmax_sku;
              if (sku && newTopupSkuToCredits[sku]) {
                credits = newTopupSkuToCredits[sku];
              }
            }

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

              // Server-side conversion tracking (fire-and-forget)
              trackConversion({
                eventName: "purchase",
                userId,
                value: (session.amount_total ?? 0) / 100,
                currency: (session.currency ?? "usd").toUpperCase(),
                transactionId: paymentIntentId ?? session.id,
                itemName: `${credits} credits`,
                supabaseAdmin,
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

          // True upsert — avoids a select-then-insert race condition
          const subscriptionData = {
            user_id: userId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            plan_name: planName,
            status: "active" as const,
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          };

          await supabaseAdmin
            .from("subscriptions")
            .upsert(subscriptionData, { onConflict: "user_id" });

          // Send welcome email for new subscriptions
          const { data: userData } = await supabaseAdmin.auth.admin.getUserById(userId);
          if (userData?.user?.email) {
            await sendWelcomeEmail(userData.user.email, planName);
            logStep("Welcome email sent", { userId });
          }

          // Server-side conversion tracking
          trackConversion({
            eventName: "purchase",
            userId,
            value: (event.data.object as any).amount_total != null
              ? (event.data.object as any).amount_total / 100
              : 0,
            currency: "USD",
            transactionId: (event.data.object as Stripe.Checkout.Session).id,
            itemName: `${planName} plan`,
            supabaseAdmin,
          });
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
          // The base plan is always the FIRST item in the subscription
          // (see stripeProducts.subscriptionProducts mapping). Pack
          // add-ons are additional SubscriptionItems whose price has
          // metadata.motionmax_sku === "pack_addon_*".
          const baseItem = subscription.items.data[0];
          const productRaw = baseItem.price.product;
          const productId = typeof productRaw === "string" ? productRaw : (productRaw as any)?.id ?? "";
          let planName = subscriptionProducts[productId] || "starter";

          // Look for a pack add-on SI to sync pack_quantity
          let packQuantity = 1;
          let packSubscriptionItemId: string | null = null;
          for (const item of subscription.items.data) {
            const itemProdRaw = item.price.product as unknown;
            const itemProd = typeof itemProdRaw === "object" && itemProdRaw !== null ? itemProdRaw as { metadata?: Record<string, string> } : null;
            const sku = itemProd?.metadata?.motionmax_sku;
            // Fall back: if product is just an id, fetch metadata via lookup_key on the price
            const lookupKey = (item.price as unknown as { lookup_key?: string | null })?.lookup_key ?? null;
            const effectiveSku = sku ?? (lookupKey && packAddonSkuToCredits[lookupKey] ? lookupKey : null);
            if (effectiveSku && packAddonSkuToCredits[effectiveSku]) {
              packQuantity = (item.quantity ?? 0) + 1;
              packSubscriptionItemId = item.id;
              if (planName === "starter" || planName === "free") {
                planName = packAddonSkuToCredits[effectiveSku].plan;
              }
            }
          }

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
              pack_quantity: packQuantity,
              pack_subscription_item_id: packSubscriptionItemId,
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
            const baseCredits = monthlyCredits[subData.plan_name] || 0;

            // Walk the invoice line items for any pack-addon SKUs and
            // grant their per-quantity credits on top of the base plan.
            let addonCredits = 0;
            try {
              for (const line of invoice.lines.data) {
                const priceObj = line.price as unknown as { lookup_key?: string | null; product?: unknown };
                const productRaw = priceObj?.product;
                const productObj = typeof productRaw === "object" && productRaw !== null ? productRaw as { metadata?: Record<string, string> } : null;
                const sku = productObj?.metadata?.motionmax_sku ?? priceObj?.lookup_key ?? null;
                if (sku && packAddonSkuToCredits[sku]) {
                  const perUnit = packAddonSkuToCredits[sku].perUnit;
                  const qty = line.quantity ?? 0;
                  addonCredits += perUnit * qty;
                }
              }
            } catch (e) {
              logStep("addon line scan failed (continuing with base credits)", { error: String(e) });
            }

            const credits = baseCredits + addonCredits;
            if (credits > 0) {
              // ── C-7-13 (Ghost G-C3): per-invoice idempotency ─────────
              // The check at the top of the handler already collapses
              // duplicate events by event_id, but Stripe occasionally
              // emits two DIFFERENT events for the same invoice
              // (e.g. an at-least-once re-delivery from the dashboard
              // after a failed webhook receipt, or a manual resend).
              // grant_monthly_credits_idempotent reserves the
              // invoice_id in stripe_processed_invoices and only
              // grants credits when that INSERT actually adds a row.
              // The RPC wraps the credit-grant + transaction-log writes
              // in the same SQL transaction as the idempotency record,
              // so credits and the invoice-row can never disagree.
              const description = addonCredits > 0
                ? `Monthly ${subData.plan_name} plan renewal: ${baseCredits} + ${addonCredits} pack add-on = ${credits} credits`
                : `Monthly ${subData.plan_name} plan renewal: ${credits} credits`;

              const { data: grantedRaw, error: creditError } = await supabaseAdmin.rpc(
                "grant_monthly_credits_idempotent",
                {
                  p_invoice_id: invoice.id,
                  p_user_id: subData.user_id,
                  p_customer_id: customerId,
                  p_plan_name: subData.plan_name,
                  p_credits: credits,
                  p_amount_paid_cents: invoice.amount_paid ?? 0,
                  p_currency: invoice.currency ?? "usd",
                  p_description: description,
                },
              );

              if (creditError) {
                // RPC-missing fallback: brief window after deploy +
                // before migration applied. Use the legacy direct path
                // so users don't miss a renewal cycle. Once the
                // migration lands, this branch is dead code.
                const errMsg = (creditError.message || "").toLowerCase();
                const missingRpc = errMsg.includes("does not exist")
                  || errMsg.includes("not found")
                  || errMsg.includes("schema cache")
                  || errMsg.includes("pgrst202");
                if (missingRpc) {
                  logStep("WARN: grant_monthly_credits_idempotent RPC missing — using legacy non-idempotent path", { invoiceId: invoice.id });
                  const { error: legacyErr } = await supabaseAdmin.rpc("increment_user_credits", {
                    p_user_id: subData.user_id,
                    p_credits: credits,
                  });
                  if (legacyErr) {
                    logStep("ERROR: Failed to grant monthly credits (legacy path)", { userId: subData.user_id, credits, error: legacyErr.message });
                  } else {
                    await supabaseAdmin.from("credit_transactions").insert({
                      user_id: subData.user_id,
                      amount: credits,
                      transaction_type: "monthly_renewal",
                      description,
                    });
                    logStep("Monthly credits granted (legacy path)", { userId: subData.user_id, plan: subData.plan_name, base: baseCredits, addon: addonCredits });
                  }
                } else {
                  logStep("ERROR: Failed to grant monthly credits", { userId: subData.user_id, credits, error: creditError.message });
                }
              } else {
                const granted = typeof grantedRaw === "number" ? grantedRaw : Number(grantedRaw ?? 0);
                if (granted === 0) {
                  // Duplicate invoice — credits already granted on a
                  // prior delivery. Return 200 so Stripe doesn't retry.
                  logStep("Duplicate invoice, skipping monthly credit grant", {
                    invoiceId: invoice.id,
                    userId: subData.user_id,
                  });
                } else {
                  logStep("Monthly credits granted (idempotent)", {
                    userId: subData.user_id,
                    plan: subData.plan_name,
                    base: baseCredits,
                    addon: addonCredits,
                    invoiceId: invoice.id,
                  });
                }
              }
            }
          }
        }

        // ── B-NEW-8: Branded purchase receipt ──────────────────────────
        // Fires for both subscription invoices AND one-time invoiced
        // purchases (top-up packs that go through the Stripe Invoice
        // surface). One-time non-invoiced top-ups still flow through
        // checkout.session.completed and are receipted by Stripe's
        // built-in card-payment receipt — that's a separate surface.
        //
        // Skip $0 invoices (free-tier conversions, trial credits) so we
        // don't spam users with receipts for nothing.
        try {
          if (invoice.amount_paid > 0 && invoice.customer_email) {
            // Resolve user (preferred) by joining customer_id → subscriptions
            // → user_id. Fall back to the invoice's customer email for
            // edge cases (legacy customers without a subscription row).
            const { data: receiptSubData } = await supabaseAdmin
              .from("subscriptions")
              .select("user_id, plan_name")
              .eq("stripe_customer_id", customerId)
              .maybeSingle();

            const recipientEmail = invoice.customer_email;
            const planLabel = receiptSubData?.plan_name
              ?? (invoice.subscription ? "subscription" : "credit pack");

            // Build line-items HTML — one <tr> per Stripe line.
            const lineItemsHtml = invoice.lines.data.map((line) => {
              const desc = (line.description ?? "Charge").replace(/[<>]/g, "");
              const qty = line.quantity ?? 1;
              const amt = ((line.amount ?? 0) / 100).toFixed(2);
              const cur = (line.currency ?? invoice.currency ?? "usd").toUpperCase();
              const qtyStr = qty > 1 ? ` &times;${qty}` : "";
              return `<tr><td style="padding:10px 12px;font-size:13.5px;color:#C8CCCE;border-bottom:1px solid rgba(255,255,255,.04);">${desc}${qtyStr}</td><td align="right" style="padding:10px 12px;font-size:13.5px;color:#C8CCCE;border-bottom:1px solid rgba(255,255,255,.04);">${cur} ${amt}</td></tr>`;
            }).join("");

            const totalStr = `${(invoice.currency ?? "usd").toUpperCase()} ${(invoice.amount_paid / 100).toFixed(2)}`;
            const periodStr = invoice.period_start && invoice.period_end
              ? `${new Date(invoice.period_start * 1000).toUTCString().slice(5, 16)} – ${new Date(invoice.period_end * 1000).toUTCString().slice(5, 16)}`
              : new Date((invoice.created ?? Date.now() / 1000) * 1000).toUTCString().slice(5, 16);
            const invoiceUrl = invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "https://motionmax.io/settings/billing";

            // Build unsubscribe URL via the existing token RPC. Receipts
            // are transactional so unsubscribe isn't strictly required,
            // but the layout includes the slot for consistency and CAN-
            // SPAM safety.
            let unsubscribeUrl = "https://motionmax.io/unsubscribe";
            if (receiptSubData?.user_id) {
              const { data: tok } = await supabaseAdmin.rpc("ensure_unsubscribe_token", {
                p_user_id: receiptSubData.user_id,
              });
              if (tok) unsubscribeUrl = `https://motionmax.io/unsubscribe?t=${encodeURIComponent(tok as string)}`;
            }

            await sendBrandedReceiptEmail({
              to: recipientEmail,
              plan: planLabel,
              lineItemsHtml,
              total: totalStr,
              period: periodStr,
              invoiceUrl,
              unsubscribeUrl,
              // Wave C Herald — the Stripe event id doubles as our
              // distributed trace id (see Sentry.setTag("trace_id",
              // event.id) above). Surface it in the receipt footer so
              // support can pull the exact webhook trace from a
              // user-reported reference number without asking them to
              // dig through Stripe.
              traceId: event.id,
            });
            logStep("Branded receipt sent", { invoiceId: invoice.id, to: recipientEmail });
          } else if (invoice.amount_paid === 0) {
            logStep("Skipping branded receipt — $0 invoice", { invoiceId: invoice.id });
          }
        } catch (receiptErr) {
          // Non-fatal — Stripe's default receipt still goes out, and
          // failing the webhook would force a retry that re-runs the
          // credit grant above. Log and move on.
          logStep("WARN: branded receipt send failed (non-fatal)", {
            invoiceId: invoice.id,
            error: receiptErr instanceof Error ? receiptErr.message : String(receiptErr),
          });
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

    // === C-9-8: mark audit row "completed" ===
    // Handlers ran without throwing, so flip the pre-reserved audit
    // row from "processing" to "completed". This row + the body hash
    // are the SOC 2 / PCI record-of-record for this event. If this
    // UPDATE fails we still return 200 (handlers committed; resending
    // would re-run them via idempotency anyway), but we log + Sentry
    // so the row mismatch is investigated.
    const { error: auditCompleteError } = await supabaseAdmin
      .from("webhook_events")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("event_id", event.id);

    if (auditCompleteError) {
      logStep("WARNING: Audit completion update failed", { message: auditCompleteError.message });
      Sentry.captureMessage(`Stripe webhook audit completion failed for ${event.id}: ${auditCompleteError.message}`, { level: "error" });
    } else {
      logStep("Event audit row completed", { eventId: event.id });
    }

    // Mirror every successfully-processed Stripe event into system_logs
    // so the admin Activity Feed surfaces revenue motion in real time.
    // The userId is best-effort: pulled from session metadata when
    // available, otherwise NULL (still useful for category filtering).
    {
      const obj = event.data.object as { metadata?: Record<string, unknown>; customer?: string; client_reference_id?: string };
      const userIdFromEvent =
        (typeof obj.metadata?.user_id === "string" ? obj.metadata.user_id : undefined) ??
        (typeof obj.client_reference_id === "string" ? obj.client_reference_id : undefined);
      const mapped = eventTypeToSystem(event.type);
      await writeSystemLog({
        supabase: supabaseAdmin,
        category: mapped.category,
        event_type: mapped.event_type,
        userId: userIdFromEvent,
        message: `Stripe webhook: ${event.type}`,
        details: {
          stripe_event_id: event.id,
          stripe_event_type: event.type,
          customer_id: typeof obj.customer === "string" ? obj.customer : undefined,
        },
      });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    Sentry.captureException(error);

    // C-9-8: if we already reserved an audit row, flip it to "failed"
    // so the audit trail records the attempt + error. Best-effort —
    // a DB outage here would also have prevented the original reservation,
    // so we don't have a row to flip in that case.
    if (reservedAuditEventId) {
      try {
        await supabaseAdmin
          .from("webhook_events")
          .update({
            status: "failed",
            error_message: errorMessage.substring(0, 500),
            completed_at: new Date().toISOString(),
          })
          .eq("event_id", reservedAuditEventId);
      } catch (auditErr) {
        logStep("Audit failure-flip best-effort errored", { message: (auditErr as Error).message });
      }
    }

    await Sentry.flush(2000);
    return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
}
// Test-only export: importable from index.test.ts without booting the server.
export const __forTesting = { handler };

// Only spin up the HTTP listener when this module is the entry point. Tests
// `import { handler } from "./index.ts"` and exercise it directly.
if (import.meta.main) {
  serve(handler);
}
