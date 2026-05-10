import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { writeSystemLog } from "../_shared/log.ts";
import { buildEmail } from "../_shared/emailTemplate.ts";

/**
 * Optional dependency-injection seam for tests (Probe F-10-04 / B-NEW-20).
 * Production code calls `handler(req)` and we construct the clients from env.
 * Tests call `handler(req, { stripe, supabaseAdmin })` with mocks.
 */
export interface DeleteAccountDeps {
  // deno-lint-ignore no-explicit-any
  stripe?: any;
  // deno-lint-ignore no-explicit-any
  supabaseAdmin?: any;
}

export async function handler(req: Request, deps: DeleteAccountDeps = {}): Promise<Response> {
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

    const supabaseAdmin = deps.supabaseAdmin ?? createClient(
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
      if (deps.stripe || stripeKey) {
        const stripe = deps.stripe ?? new Stripe(stripeKey ?? "", { apiVersion: "2024-12-18.acacia" });
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

    // C-3-5: Out-of-band confirmation. The previous flow scheduled
    // deletion with ZERO email signal — a session-stealing attacker
    // could nuke the account and the real user wouldn't know until day
    // 7. We now email the address on file with a cancel link. Failure
    // here is non-fatal (we already scheduled deletion + logged it);
    // we just log a warning so SRE can see if Resend is down.
    if (user.email) {
      try {
        const formattedDate = new Date(scheduledAt).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
        const cancelUrl = "https://motionmax.io/settings#deletion";
        const html = buildEmail({
          preheader: `Your MotionMax account is scheduled for deletion on ${formattedDate}.`,
          greeting: "Hi there,",
          headline: "Account deletion scheduled",
          bodyHtml: `
            <p>We received a request to delete your MotionMax account. Your account and all data will be permanently removed on <strong style="color:#E4C875;">${formattedDate}</strong>.</p>
            <p><strong style="color:#E4C875;">Didn't request this?</strong> Sign back in and click the button below to cancel — you have until the scheduled date.</p>
            <p>This includes:</p>
            <ul style="padding-left:20px;margin:8px 0 0 0;color:#C8CCCE;">
              <li style="margin-bottom:6px;">All projects and video generations</li>
              <li style="margin-bottom:6px;">Voice clones and audio files</li>
              <li style="margin-bottom:6px;">Remaining credits (no refund)</li>
              <li style="margin-bottom:6px;">Your account and profile</li>
            </ul>
          `,
          cta: { label: "Cancel deletion request", href: cancelUrl },
          footerNote:
            "If you didn't ask to delete your account and the cancel button doesn't work, reply to this email and we'll cancel it manually.",
        });
        const apiKey = Deno.env.get("RESEND_API_KEY");
        if (apiKey) {
          const fromAddr =
            Deno.env.get("RESEND_FROM_EMAIL") ?? "MotionMax <noreply@motionmax.io>";
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: fromAddr,
              to: user.email,
              subject: "Your MotionMax account is scheduled for deletion",
              html,
            }),
          });
          if (!res.ok) {
            const txt = await res.text();
            console.warn("[delete-account] confirmation email failed", {
              status: res.status,
              body: txt,
            });
          }
        } else {
          console.warn("[delete-account] RESEND_API_KEY not set — confirmation email skipped");
        }
      } catch (mailErr) {
        // Best-effort — deletion already scheduled, don't fail the
        // request if Resend has an outage.
        console.warn("[delete-account] confirmation email threw", mailErr);
      }
    }

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
// Test-only export.
export const __forTesting = { handler };

if (import.meta.main) {
  serve(handler);
}
