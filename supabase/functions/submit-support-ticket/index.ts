import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import * as Sentry from "https://deno.land/x/sentry/index.mjs";
import { scrubSentryEvent } from "../_shared/sentry-scrubber.ts";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN") || "",
  environment: Deno.env.get("DENO_DEPLOYMENT_ID") ? "production" : "development",
  beforeSend: scrubSentryEvent,
});

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[SUBMIT-SUPPORT-TICKET] ${step}${detailsStr}`);
};

class UserFacingError extends Error {
  constructor(message: string) { super(message); this.name = "UserFacingError"; }
}

const ALLOWED_TOPICS = new Set(["billing", "render", "voice", "account", "api", "other"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORT_INBOX = "support@motionmax.io";

interface TicketBody {
  name?: unknown;
  email?: unknown;
  subject?: unknown;
  body?: unknown;
  topic?: unknown;
}

function asTrimmed(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendNotificationEmail(payload: {
  to: string;
  ticketId: string;
  name: string;
  email: string;
  topic: string;
  subject: string;
  body: string;
}): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    logStep("Resend skipped — no API key");
    return;
  }
  const html = `
    <h2>New support ticket</h2>
    <p><strong>Ticket:</strong> ${escapeHtml(payload.ticketId)}</p>
    <p><strong>From:</strong> ${escapeHtml(payload.name)} &lt;${escapeHtml(payload.email)}&gt;</p>
    <p><strong>Topic:</strong> ${escapeHtml(payload.topic)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(payload.subject)}</p>
    <hr/>
    <pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(payload.body)}</pre>
  `;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "MotionMax <noreply@motionmax.io>",
        to: payload.to,
        reply_to: payload.email,
        subject: `[${payload.topic}] ${payload.subject}`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      logStep("Resend failed", { status: res.status, body: txt });
    }
  } catch (err) {
    logStep("Resend error", { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 405,
      });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new UserFacingError("No authorization header provided");
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new UserFacingError("Authentication failed. Please sign in again.");
    const user = userData.user;
    if (!user) throw new UserFacingError("User not authenticated");

    const rl = await checkRateLimit(supabaseClient, {
      key: "submit-support-ticket", maxRequests: 3, windowSeconds: 300, userId: user.id,
    });
    if (!rl.allowed) {
      return new Response(JSON.stringify({ error: "Too many tickets — please wait a few minutes before sending another." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 429,
      });
    }

    let parsed: TicketBody;
    try {
      parsed = await req.json() as TicketBody;
    } catch {
      throw new UserFacingError("Invalid JSON body");
    }

    const name    = asTrimmed(parsed.name,    200);
    const email   = asTrimmed(parsed.email,   200);
    const subject = asTrimmed(parsed.subject, 300);
    const body    = asTrimmed(parsed.body,    20_000);
    const topicRaw = asTrimmed(parsed.topic,  40);

    if (!name)    throw new UserFacingError("Name is required");
    if (!email || !EMAIL_RE.test(email)) throw new UserFacingError("A valid email is required");
    if (!subject) throw new UserFacingError("Subject is required");
    if (!body)    throw new UserFacingError("Description is required");
    if (!ALLOWED_TOPICS.has(topicRaw)) throw new UserFacingError("Invalid topic");

    const { data: insertData, error: insertError } = await supabaseClient
      .from("support_tickets")
      .insert({
        user_id: user.id,
        name,
        email,
        subject,
        body,
        topic: topicRaw,
      })
      .select("id")
      .single();

    if (insertError || !insertData) {
      logStep("Insert failed", { error: insertError?.message });
      throw new Error(insertError?.message ?? "Failed to create ticket");
    }

    const ticketId = insertData.id as string;
    logStep("Ticket created", { id: ticketId, user_id: user.id });

    // Best-effort email notification — never block the response on it.
    await sendNotificationEmail({
      to: SUPPORT_INBOX,
      ticketId,
      name,
      email,
      topic: topicRaw,
      subject,
      body,
    });

    return new Response(JSON.stringify({ ok: true, id: ticketId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    if (!(error instanceof UserFacingError)) {
      Sentry.captureException(error);
      await Sentry.flush(2000);
    }
    const clientMessage = error instanceof UserFacingError ? errorMessage : "An unexpected error occurred.";
    const status = error instanceof UserFacingError ? 400 : 500;
    return new Response(JSON.stringify({ error: clientMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }, status,
    });
  }
}

serve(handler);
