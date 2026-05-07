/**
 * admin-send-newsletter — admin-only edge fn that dispatches a saved
 * newsletter campaign via Resend.
 *
 * Auth flow:
 *   1. Bearer JWT → resolve user via supabase.auth.getUser
 *   2. Verify is_admin(user.id) via service-role client
 *   3. Look up campaign by id; bail if status != 'draft' OR 'scheduled'
 *      and sent_at IS NOT NULL (idempotent — re-runs no-op cleanly)
 *   4. Build recipients from `audience` text:
 *        all_opted_in → profiles.marketing_opt_in = true
 *        plan:<name>  → join subscriptions where plan_name ilike <name>
 *   5. Insert pending newsletter_sends rows (UNIQUE(campaign_id,user_id))
 *      — ON CONFLICT DO NOTHING handles re-runs.
 *   6. For each recipient: POST to Resend, mark sent/failed.
 *   7. Mark campaign sent + sent_at on first successful send batch.
 *
 * Sends are issued sequentially with a small delay to stay under
 * Resend's rate limit (10 req/s on free; we do ~5 req/s).
 *
 * Rate limit: 1 send per campaign — enforced by sent_at being non-null.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "MotionMax <noreply@motionmax.io>";
const PER_RECIPIENT_DELAY_MS = 200; // ~5 req/s (Resend free tier is 10 req/s)
const MAX_RECIPIENTS_PER_CALL = 5000;

interface CampaignRow {
  id: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  audience: string;
  status: string;
  sent_at: string | null;
}

interface ProfileRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

function logStep(step: string, details?: unknown): void {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[ADMIN-SEND-NEWSLETTER] ${step}${detailsStr}`);
}

async function sendOne(args: {
  apiKey: string;
  to: string;
  subject: string;
  html: string;
  text: string | null;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const { apiKey, to, subject, html, text } = args;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        html,
        text: text ?? undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: typeof data?.id === "string" ? data.id : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") {
    return handleCorsPreflightRequest(req.headers.get("origin"));
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    // 1. Bearer auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "missing bearer token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const callerId = userData.user.id;

    // 2. Admin gate via is_admin(uid). Service role bypasses RLS.
    const { data: roleRow, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId)
      .eq("role", "admin")
      .maybeSingle();
    if (roleErr || !roleRow) {
      return new Response(JSON.stringify({ error: "forbidden — admin only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse body
    const body = await req.json().catch(() => ({}));
    const newsletterId = typeof body?.newsletter_id === "string" ? body.newsletter_id : "";
    if (!newsletterId) {
      return new Response(JSON.stringify({ error: "newsletter_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Lookup campaign
    const { data: campaignRow, error: campaignErr } = await supabaseAdmin
      .from("newsletter_campaigns")
      .select("id, subject, body_html, body_text, audience, status, sent_at")
      .eq("id", newsletterId)
      .maybeSingle();
    if (campaignErr || !campaignRow) {
      return new Response(JSON.stringify({ error: "campaign not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const campaign = campaignRow as CampaignRow;

    // Idempotency: if already sent, no-op success.
    if (campaign.sent_at) {
      logStep("skip — already sent", { id: campaign.id, sent_at: campaign.sent_at });
      return new Response(
        JSON.stringify({ ok: true, already_sent: true, campaign_id: campaign.id, sent_at: campaign.sent_at }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (campaign.status === "cancelled") {
      return new Response(JSON.stringify({ error: "campaign cancelled" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (campaign.status === "sending") {
      return new Response(JSON.stringify({ error: "campaign already sending" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Atomic flip → 'sending' so a second concurrent invocation bails.
    const { data: claimRow, error: claimErr } = await supabaseAdmin
      .from("newsletter_campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaign.id)
      .in("status", ["draft", "scheduled"])
      .select("id")
      .maybeSingle();
    if (claimErr || !claimRow) {
      return new Response(JSON.stringify({ error: "could not claim campaign — concurrent send?" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Resolve audience → recipients
    const recipients: ProfileRow[] = [];

    if (campaign.audience === "all_opted_in" || campaign.audience === "all") {
      const { data: optedIn, error: optInErr } = await supabaseAdmin
        .from("profiles")
        .select("user_id, email, display_name")
        .eq("marketing_opt_in", true)
        .is("deleted_at", null)
        .is("newsletter_unsubscribed_at", null)
        .limit(MAX_RECIPIENTS_PER_CALL);
      if (optInErr) throw new Error(`profiles fetch: ${optInErr.message}`);
      for (const row of optedIn ?? []) recipients.push(row as ProfileRow);
    } else if (campaign.audience.startsWith("plan:")) {
      const planName = campaign.audience.slice(5);
      const { data: subs, error: subsErr } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id")
        .eq("status", "active")
        .ilike("plan_name", planName)
        .limit(MAX_RECIPIENTS_PER_CALL);
      if (subsErr) throw new Error(`subscriptions fetch: ${subsErr.message}`);
      const ids = Array.from(new Set((subs ?? []).map((s) => s.user_id as string)));
      if (ids.length > 0) {
        const { data: profs, error: profErr } = await supabaseAdmin
          .from("profiles")
          .select("user_id, email, display_name")
          .in("user_id", ids)
          .eq("marketing_opt_in", true)
          .is("deleted_at", null)
          .is("newsletter_unsubscribed_at", null);
        if (profErr) throw new Error(`profiles join: ${profErr.message}`);
        for (const row of profs ?? []) recipients.push(row as ProfileRow);
      }
    } else {
      // Unknown audience string → bail before sending.
      await supabaseAdmin
        .from("newsletter_campaigns")
        .update({ status: "draft", updated_at: new Date().toISOString() })
        .eq("id", campaign.id);
      return new Response(JSON.stringify({ error: `unknown audience: ${campaign.audience}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Profiles can carry NULL email (auth.users holds the canonical address).
    // Hydrate any missing email via the auth admin lookup.
    const missingEmailIds = recipients.filter((r) => !r.email).map((r) => r.user_id);
    if (missingEmailIds.length > 0) {
      // Bulk listing is paginated; we keep the cost bounded by only resolving
      // the missing rows. Auth admin doesn't expose a "by ids" API, so we
      // fall back to per-id lookups (small in practice — most profiles have
      // emails populated already).
      for (const uid of missingEmailIds) {
        const { data: au } = await supabaseAdmin.auth.admin.getUserById(uid);
        const target = recipients.find((r) => r.user_id === uid);
        if (target && au?.user?.email) target.email = au.user.email;
      }
    }

    const validRecipients = recipients.filter((r) => typeof r.email === "string" && r.email.includes("@"));

    if (validRecipients.length === 0) {
      // Nothing to send — flip back so admin can re-target the campaign.
      await supabaseAdmin
        .from("newsletter_campaigns")
        .update({ status: "draft", updated_at: new Date().toISOString() })
        .eq("id", campaign.id);
      return new Response(
        JSON.stringify({ error: "no recipients matched the audience filter" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 6. Insert pending newsletter_sends rows. Idempotent via UNIQUE.
    const sendsRows = validRecipients.map((r) => ({
      campaign_id: campaign.id,
      user_id: r.user_id,
      email: r.email as string,
      status: "pending" as const,
    }));
    // Chunk to avoid jsonb payload bloat at scale.
    for (let i = 0; i < sendsRows.length; i += 500) {
      const chunk = sendsRows.slice(i, i + 500);
      const { error: insErr } = await supabaseAdmin
        .from("newsletter_sends")
        .upsert(chunk, { onConflict: "campaign_id,user_id", ignoreDuplicates: true });
      if (insErr) throw new Error(`newsletter_sends upsert: ${insErr.message}`);
    }

    // 7. Send via Resend
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      // RESEND_API_KEY absent. Mark sent_at so the row reflects "dispatched"
      // — same fail-soft pattern resend.ts uses for transactional emails.
      logStep("RESEND_API_KEY missing — marking sent without delivery");
      await supabaseAdmin
        .from("newsletter_campaigns")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id);
      return new Response(
        JSON.stringify({
          ok: true,
          campaign_id: campaign.id,
          recipients: validRecipients.length,
          sent: 0,
          warning: "RESEND_API_KEY not configured — campaign marked sent but no emails were delivered",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let okCount = 0;
    let errCount = 0;

    for (const r of validRecipients) {
      const result = await sendOne({
        apiKey,
        to: r.email as string,
        subject: campaign.subject,
        html: campaign.body_html,
        text: campaign.body_text,
      });

      const updateRow = result.ok
        ? {
            status: "sent",
            sent_at: new Date().toISOString(),
            resend_message_id: result.messageId,
            error: null as string | null,
          }
        : {
            status: "failed",
            error: result.error,
          };

      const { error: updErr } = await supabaseAdmin
        .from("newsletter_sends")
        .update(updateRow)
        .eq("campaign_id", campaign.id)
        .eq("user_id", r.user_id);
      if (updErr) {
        logStep("send row update failed", { user_id: r.user_id, err: updErr.message });
      }

      if (result.ok) okCount++;
      else errCount++;

      if (PER_RECIPIENT_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, PER_RECIPIENT_DELAY_MS));
      }
    }

    // 8. Mark campaign sent
    await supabaseAdmin
      .from("newsletter_campaigns")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", campaign.id);

    // 9. Audit log
    await supabaseAdmin.from("admin_logs").insert({
      admin_id: callerId,
      action: "campaign_dispatched",
      target_type: "newsletter_campaign",
      target_id: campaign.id,
      details: { recipients: validRecipients.length, sent: okCount, failed: errCount, audience: campaign.audience },
      ip_address: req.headers.get("x-forwarded-for") || null,
      user_agent: req.headers.get("user-agent") || null,
    });

    logStep("done", { id: campaign.id, sent: okCount, failed: errCount, recipients: validRecipients.length });

    return new Response(
      JSON.stringify({
        ok: true,
        campaign_id: campaign.id,
        recipients: validRecipients.length,
        sent: okCount,
        failed: errCount,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ADMIN-SEND-NEWSLETTER] ERROR", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

serve(handler);
