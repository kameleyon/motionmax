// B-V1-5 (Comply L-B-05) — EU/EEA/UK 14-day right of withdrawal waiver.
//
// Directive 2011/83/EU Art. 16(m) (and UK Consumer Rights Act 2015 + CCRs 2013
// reg. 37) require express, evidenced consent before a consumer loses the
// 14-day cooling-off period for a digital service. The frontend captures the
// consent via a checkbox (see src/lib/euCoolingOff.ts and src/pages/Pricing.tsx)
// and passes `eu_cooling_off_waived: true` in this function's request body.
// When that flag is true and we have an authenticated user, we stamp
// `profiles.eu_cooling_off_waived_at` BEFORE creating the Stripe Checkout
// Session so we have a server-side, timestamped record of the waiver. A DB
// failure does NOT block checkout — the Stripe customer record itself
// preserves the evidence and we can reconcile any missing rows out-of-band.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";
import { scrubSentryEvent } from "../_shared/sentry-scrubber.ts";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
  // billing endpoints use full trace sampling per audit C-9-2 — every failed
  // checkout MUST be reproducible. This function is the entry point for
  // Stripe Checkout Sessions; if it fails the user sees "checkout failed"
  // with no Stripe session to debug, so we need the full distributed trace.
  tracesSampleRate: 1.0,
  beforeSend: scrubSentryEvent,
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

/**
 * Optional dependency-injection seam for tests (Probe F-10-04 / B-NEW-20).
 */
export interface CreateCheckoutDeps {
  // deno-lint-ignore no-explicit-any
  stripe?: any;
  // deno-lint-ignore no-explicit-any
  supabaseClient?: any;
  /** Override for the dynamic import of ../_shared/killSwitch.ts. */
  rejectIfMaintenanceOrKilled?: (
    // deno-lint-ignore no-explicit-any
    supabase: any,
    key: string,
    headers: Record<string, string>,
    req: Request,
  ) => Promise<Response | null>;
}

export async function handler(req: Request, deps: CreateCheckoutDeps = {}): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }

  const supabaseClient = deps.supabaseClient ?? createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // Audit C-9-6: read the trace ID from the request header so every Sentry
  // event from this invocation is tagged. The body-mirrored `_trace_id`
  // (set by invokeWithTrace) is the fallback when the header gets eaten by
  // an intermediate transport. Generated locally if neither is present so
  // we always have *some* correlation ID for the support ticket.
  const traceIdFromHeader = req.headers.get("X-Trace-Id") || req.headers.get("x-trace-id");

  try {
    logStep("Function started");

    // Phase 17.2 + 17.3 — master kill OR `payments` kill switch.
    // Admins are exempt so admin-side reconciliation tools keep
    // working during a maintenance window.
    const rejectIfMaintenanceOrKilled = deps.rejectIfMaintenanceOrKilled ?? (
      await import("../_shared/killSwitch.ts")
    ).rejectIfMaintenanceOrKilled;
    const blocked = await rejectIfMaintenanceOrKilled(supabaseClient, "pause_payments", corsHeaders, req);
    if (blocked) return blocked;

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

    // ── Request body parsing ──────────────────────────────────────
    //
    // B-NEW-21 (2026-05-10): support two request shapes in addition to
    // the legacy `{ priceId, mode }`:
    //
    //   Subscription (Creator / Studio):
    //     {
    //       tier:    'creator' | 'studio',
    //       cycle:   'monthly' | 'yearly',
    //       multipack: 1..6,                    // quantity multiplier
    //       eu_cooling_off_waived?: boolean,
    //     }
    //
    //   Top-up (one-time credit pack, available to Free too):
    //     {
    //       kind: 'topup',
    //       sku:  'quick' | 'plus' | 'power' | 'studio' | 'pro',
    //       eu_cooling_off_waived?: boolean,
    //     }
    //
    // The legacy `priceId` shape is still accepted so existing
    // /pricing flows + credit-pack buttons keep working until they're
    // fully migrated.
    const body = await req.json();
    const {
      priceId: rawPriceId,
      mode: rawMode,
      tier,
      cycle,
      multipack,
      kind,
      sku,
      eu_cooling_off_waived: euCoolingOffWaived,
      _trace_id: bodyTraceId,
    } = body;

    // Audit C-9-6: resolve the effective trace ID (header > body > generated)
    // and attach as a Sentry tag + log breadcrumb so every event during this
    // invocation is searchable by trace_id in Sentry. The worker side does
    // the same via job.payload.traceId, so the same ID ties together both
    // halves of a stripe-driven flow.
    const traceId: string = traceIdFromHeader || (typeof bodyTraceId === "string" ? bodyTraceId : "") || crypto.randomUUID();
    Sentry.setTag("trace_id", traceId);
    logStep("Trace ID resolved", { trace_id: traceId });

    const stripe = deps.stripe ?? new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
      apiVersion: "2024-12-18.acacia",
    });

    // Resolve Stripe IDs from env vars based on the request shape.
    // STRIPE_MODE=test|live drives the suffix on each var name so we
    // can keep test+live IDs side-by-side and flip per environment.
    const STRIPE_MODE = (Deno.env.get("STRIPE_MODE") ?? "test").toLowerCase();
    const SUFFIX = STRIPE_MODE === "live" ? "LIVE" : "TEST";

    let priceId: string | undefined = rawPriceId;
    let mode: "subscription" | "payment" = rawMode === "payment" ? "payment" : "subscription";
    let quantity = 1;
    let promoCouponId: string | undefined;

    if (kind === "topup" && typeof sku === "string") {
      const skuKey = sku.toUpperCase();
      priceId = Deno.env.get(`STRIPE_PRICE_TOPUP_${skuKey}_${SUFFIX}`);
      mode = "payment";
      if (!priceId) {
        throw new UserFacingError(`Top-up pack '${sku}' is not configured. Please run the Stripe sync script.`);
      }
    } else if (typeof tier === "string" && typeof cycle === "string") {
      const tierKey = tier.toUpperCase();
      const cycleKey = cycle.toUpperCase();
      if (tierKey !== "CREATOR" && tierKey !== "STUDIO") {
        throw new UserFacingError("Unknown subscription tier");
      }
      if (cycleKey !== "MONTHLY" && cycleKey !== "YEARLY") {
        throw new UserFacingError("Unknown billing cycle");
      }
      priceId = Deno.env.get(`STRIPE_PRICE_${tierKey}_${cycleKey}_${SUFFIX}`);
      if (!priceId) {
        throw new UserFacingError(`Subscription price for ${tier}/${cycle} is not configured. Please run the Stripe sync script.`);
      }
      mode = "subscription";

      // Multi-pack ladder — implemented as Stripe SubscriptionItem
      // quantity. Defaults to 1× (the base allotment).
      const m = Number(multipack ?? 1);
      if (!Number.isFinite(m) || m < 1 || m > 6) {
        throw new UserFacingError("Multipack must be between 1 and 6.");
      }
      quantity = Math.floor(m);

      // Promo coupon (3-month repeating, ~30-34% off) — only attaches
      // to MONTHLY subscriptions. Yearly is already discounted up-front
      // and shouldn't compound. The coupon's `duration_in_months: 3`
      // semantics mean Stripe automatically reverts to the standard
      // monthly rate from the 4th billing cycle.
      if (cycleKey === "MONTHLY") {
        promoCouponId = Deno.env.get(`STRIPE_COUPON_${tierKey}_PROMO_${SUFFIX}`);
        // Coupon is optional — if not configured, skip (the price is
        // simply the standard monthly rate from the start).
      }
    }

    if (!priceId) throw new UserFacingError("Price ID is required");

    // Dynamic validation: fetch the price from Stripe and verify it is active
    // and belongs to one of our known products (product IDs are stable),
    // OR has `metadata.motionmax_sku` set (the new 2026-05-06 SKU catalog
    // created by scripts/stripe-create-billing-products.ts AND the
    // 2026-05-10 catalog from scripts/sync-stripe-products.mjs).
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

    logStep("Price validated", {
      priceId,
      productId,
      active: price.active,
      sku: productMeta.motionmax_sku,
      quantity,
      promoCouponId: promoCouponId ?? null,
      stripeMode: STRIPE_MODE,
    });

    // B-V1-5 — record the EU/EEA/UK 14-day cooling-off waiver, if the user
    // ticked the binding checkbox on the frontend. We stamp the profile row
    // BEFORE creating the Stripe Checkout Session so the evidence exists at
    // the moment the consumer loses the statutory right. A DB failure here
    // does NOT block checkout: the Stripe customer record will still carry
    // the same intent (the user is about to pay) and we can reconcile any
    // missing rows from Stripe webhooks out-of-band. See
    // supabase/migrations/20260510120100_eu_cooling_off_waived_at.sql for
    // the column definition and Directive 2011/83/EU Art. 16(m) citation.
    if (euCoolingOffWaived === true && user?.id) {
      const { error: waiverErr } = await supabaseClient
        .from("profiles")
        .update({ eu_cooling_off_waived_at: new Date().toISOString() })
        .eq("id", user.id);
      if (waiverErr) {
        // Non-fatal — log so an operator can reconcile, but proceed.
        logStep("EU cooling-off waiver persist FAILED (non-blocking)", {
          userId: user.id,
          error: waiverErr.message,
        });
      } else {
        logStep("EU cooling-off waiver persisted", { userId: user.id });
      }
    }

    // Check for existing Stripe customer
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    let customerId: string | undefined;
    if (customers.data.length > 0) {
      customerId = customers.data[0].id;
      logStep("Found existing customer");
    }

    const origin = req.headers.get("origin") || "https://motionmax.io";

    // B-NEW-21 — Stripe Checkout Session.
    //
    // `discounts` accepts an array of coupon refs (NOT both `discounts`
    // and `allow_promotion_codes` — they're mutually exclusive). The
    // promo coupon is `duration: 'repeating', duration_in_months: 3`
    // so Stripe auto-reverts to standard pricing from cycle 4 — we
    // don't have to track expiry dates ourselves.
    //
    // `quantity` is the multi-pack ladder multiplier (1× through 6×).
    // For top-ups, quantity stays 1 — buying 2 Quick packs in one go
    // is not supported in this iteration.
    const sessionParams: Record<string, unknown> = {
      customer: customerId,
      customer_email: customerId ? undefined : user.email,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity }],
      mode: mode || "subscription",
      success_url: `${origin}/billing?success=true`,
      cancel_url: `${origin}/billing?canceled=true`,
      metadata: {
        user_id: user.id,
        ...(tier ? { tier: String(tier) } : {}),
        ...(cycle ? { cycle: String(cycle) } : {}),
        ...(typeof multipack === "number" ? { multipack: String(multipack) } : {}),
        ...(kind ? { kind: String(kind) } : {}),
        ...(sku ? { sku: String(sku) } : {}),
      },
    };
    if (promoCouponId && mode === "subscription") {
      sessionParams.discounts = [{ coupon: promoCouponId }];
    }
    const session = await stripe.checkout.sessions.create(sessionParams);

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
// Test-only export.
export const __forTesting = { handler };

if (import.meta.main) {
  serve(handler);
}
