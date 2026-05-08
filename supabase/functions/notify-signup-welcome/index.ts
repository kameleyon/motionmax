import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { getCorsHeaders, handleCorsPreflightRequest } from "../_shared/cors.ts";
import { sendSignupWelcomeEmail } from "../_shared/resend.ts";

// Fires the first-time welcome email after a user's first authenticated
// sign-in. Idempotent: profiles.welcome_email_sent_at is set atomically,
// and the email only goes out when the UPDATE actually claims the row
// (so a refresh / double-click can't trigger duplicates).

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[NOTIFY-SIGNUP-WELCOME] ${step}${detailsStr}`);
};

export async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return handleCorsPreflightRequest(req.headers.get("origin"));

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 405,
    });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (!user?.email) {
      return new Response(JSON.stringify({ error: "Invalid session or no email" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 401,
      });
    }

    // Atomic claim: UPDATE only fires (and returns rows) when the flag
    // is still NULL. Any concurrent caller losing the race gets zero rows
    // and we exit without sending — no duplicates.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("profiles")
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("welcome_email_sent_at", null)
      .select("user_id, display_name")
      .maybeSingle();

    if (claimErr) {
      logStep("ERROR: claim update failed", { error: claimErr.message });
      return new Response(JSON.stringify({ error: claimErr.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      });
    }

    if (!claimed) {
      logStep("Already sent — skipping", { userId: user.id });
      return new Response(JSON.stringify({ ok: true, sent: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const displayName = (claimed as { display_name?: string | null }).display_name ?? undefined;
    await sendSignupWelcomeEmail(user.email, displayName ?? undefined);
    logStep("Welcome email sent", { userId: user.id, to: user.email });

    return new Response(JSON.stringify({ ok: true, sent: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
}

serve(handler);
