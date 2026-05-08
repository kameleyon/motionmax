import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

// Phase 15.4 — Resend webhook receiver.
//
// Resend POSTs delivery / open / click / bounce / complaint events to
// this URL. We map them onto newsletter_sends (keyed by
// resend_message_id) so the Newsletter tab's open / click rates and
// the bounce / complaint columns reflect actual delivery behavior.
//
// Signature verification: Resend signs requests with `svix-signature`
// using a shared secret. We validate before doing any DB work; an
// unsigned or wrong-signature request returns 401 silently.
//
// Event types we care about:
//   email.sent          → status='sent' (already set by worker; we
//                         stamp the timestamp anyway in case of races)
//   email.delivered     → no-op (status='sent' already covers this)
//   email.opened        → status='opened', opened_at = now()
//   email.clicked       → status='clicked', clicked_at = now()
//   email.bounced       → status='bounced', error = bounce reason
//   email.complained    → status='complained' + flip the user's
//                         marketing_opt_in to false (CAN-SPAM)

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[RESEND-WEBHOOK] ${step}${detailsStr}`);
};

interface ResendEvent {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    bounce?: { type?: string; reason?: string };
    click?: { url?: string };
  };
}

async function verifySvixSignature(req: Request, body: string, secret: string): Promise<boolean> {
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const signedPayload = `${svixId}.${svixTimestamp}.${body}`;
  const keyBytes = new Uint8Array(atob(secret.replace(/^whsec_/, "")).split("").map((c) => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Header carries one or more space-separated `v1,<sig>` entries.
  const candidates = svixSignature.split(" ").map((p) => p.split(",")[1]);
  return candidates.some((c) => c === expected);
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 405,
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  const raw = await req.text();
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (secret) {
    const ok = await verifySvixSignature(req, raw, secret);
    if (!ok) {
      logStep("Invalid signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 401,
      });
    }
  } else {
    // No secret configured — accept but warn. Useful during initial
    // setup; production deployments should always set the secret.
    logStep("WARNING: RESEND_WEBHOOK_SECRET not set — signature check skipped");
  }

  let evt: ResendEvent;
  try { evt = JSON.parse(raw); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { headers: corsHeaders, status: 400 }); }

  const messageId = evt.data?.email_id;
  if (!messageId) {
    return new Response(JSON.stringify({ ok: true, ignored: "no email_id" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  }

  const now = new Date().toISOString();
  let updated = false;
  switch (evt.type) {
    case "email.sent":
    case "email.delivered":
      // Stamp sent_at if it was missing — the worker already sets it
      // on Resend POST success; this catches edge cases where the
      // webhook arrives before our INSERT commits.
      await supabaseAdmin.from("newsletter_sends")
        .update({ status: "sent", sent_at: now })
        .eq("resend_message_id", messageId)
        .neq("status", "opened")
        .neq("status", "clicked");
      updated = true;
      break;
    case "email.opened":
      await supabaseAdmin.from("newsletter_sends")
        .update({ status: "opened", opened_at: now })
        .eq("resend_message_id", messageId)
        .is("opened_at", null);
      updated = true;
      break;
    case "email.clicked":
      await supabaseAdmin.from("newsletter_sends")
        .update({ status: "clicked", clicked_at: now })
        .eq("resend_message_id", messageId);
      updated = true;
      break;
    case "email.bounced": {
      const reason = evt.data?.bounce?.reason ?? evt.data?.bounce?.type ?? "unknown";
      await supabaseAdmin.from("newsletter_sends")
        .update({ status: "bounced", error: `bounce: ${reason}` })
        .eq("resend_message_id", messageId);
      updated = true;
      break;
    }
    case "email.complained":
      await supabaseAdmin.from("newsletter_sends")
        .update({ status: "complained", error: "spam complaint" })
        .eq("resend_message_id", messageId);
      // CAN-SPAM: flip the user's opt-in to false on complaint.
      // Look up the user_id via the send row first.
      {
        const { data: row } = await supabaseAdmin.from("newsletter_sends")
          .select("user_id").eq("resend_message_id", messageId).maybeSingle();
        const uid = (row as { user_id?: string } | null)?.user_id;
        if (uid) {
          await supabaseAdmin.from("profiles")
            .update({ marketing_opt_in: false, newsletter_unsubscribed_at: now })
            .eq("user_id", uid);
        }
      }
      updated = true;
      break;
    default:
      logStep("Unhandled event type", { type: evt.type });
  }

  return new Response(JSON.stringify({ ok: true, updated, type: evt.type }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
  });
}

serve(handler);
