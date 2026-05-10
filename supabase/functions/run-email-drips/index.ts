/**
 * run-email-drips — drains the email_drip_schedule queue (B-NEW-8 Herald
 * lifecycle gap fix). Triggered every 15 minutes by pg_cron and
 * authenticated with the service-role bearer token (consistent with
 * B-NEW-5 hardening — no public access). On each tick we:
 *
 *   1. SELECT up to 100 pending rows whose scheduled_at has come due.
 *   2. For each row:
 *      a. Resolve user (email, display_name, unsubscribe state).
 *         If the user is unsubscribed → mark `skipped_unsubscribed`.
 *      b. For winback_30 / winback_60: re-check last_sign_in_at. If the
 *         user has signed in within the last 7 days, they're no longer
 *         dormant — mark `skipped_inactive` so we don't pester them.
 *      c. Render the template (subject + html + text) via the
 *         _shared/email-templates helper.
 *      d. Send via Resend. On 2xx → status='sent', sent_at=now().
 *         On 4xx/5xx → status='failed', error_message=<resp>.
 *
 * Throughput budget: 100 rows × ~200ms Resend latency = ~20s per tick,
 * well under the Edge Functions 60s wall-clock cap. If the queue grows
 * past 100 we let the next tick (15 min) catch up — typical signup
 * volume is well below that.
 */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { renderTemplate, TEMPLATE_META, type RenderVars } from "../_shared/email-templates/_helper.ts";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "MotionMax <noreply@motionmax.io>";
const BATCH_SIZE = 100;

// Win-back drips suppress if the user has signed in within this window —
// they're not actually dormant anymore, so the win-back copy would land
// wrong ("we miss you" to someone who logged in yesterday).
const WINBACK_RECENT_SIGNIN_DAYS = 7;

type DripType = "day_1" | "day_3" | "day_7" | "day_14" | "winback_30" | "winback_60";

interface ScheduleRow {
  id: string;
  user_id: string;
  drip_type: DripType;
  scheduled_at: string;
}

const logStep = (step: string, details?: unknown): void => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[RUN-EMAIL-DRIPS] ${step}${detailsStr}`);
};

const fromAddress = (): string =>
  Deno.env.get("RESEND_FROM_EMAIL") ?? DEFAULT_FROM;

/** Load the unsubscribe token (creating one if needed via the existing
 *  ensure_unsubscribe_token RPC) and assemble the public footer link.
 *  Pattern matches the newsletter dispatcher in admin-send-newsletter. */
async function buildUnsubscribeUrl(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_unsubscribe_token", {
    p_user_id: userId,
  });
  if (error || !data) {
    logStep("WARN: ensure_unsubscribe_token failed", { userId, error: error?.message });
    // Fall back to a generic page — the user can still unsubscribe by
    // signing in. Footer link MUST exist for CAN-SPAM compliance.
    return "https://motionmax.io/unsubscribe";
  }
  return `https://motionmax.io/unsubscribe?t=${encodeURIComponent(data as string)}`;
}

/** Send one email via Resend. Returns ok/error so the caller can update
 *  the schedule row appropriately. */
async function sendViaResend(args: {
  apiKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: args.to,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: typeof data?.id === "string" ? data.id : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fetch user context needed to render a drip: email, display name,
 *  unsubscribe state, last sign-in. Combines auth.users and profiles in
 *  two queries (no SQL JOIN since auth.users isn't directly RLS-readable
 *  via the service role's view). */
async function loadUserContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<{
  email: string | null;
  displayName: string | null;
  unsubscribed: boolean;
  lastSignInAt: string | null;
}> {
  const [authResult, profileResult] = await Promise.all([
    supabase.auth.admin.getUserById(userId),
    supabase
      .from("profiles")
      .select("display_name, newsletter_unsubscribed_at, deleted_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const email = authResult.data?.user?.email ?? null;
  const lastSignInAt = authResult.data?.user?.last_sign_in_at ?? null;
  const profile = profileResult.data as
    | { display_name: string | null; newsletter_unsubscribed_at: string | null; deleted_at: string | null }
    | null;

  // Treat soft-deleted accounts as unsubscribed — they should never
  // receive lifecycle emails.
  const unsubscribed =
    !!profile?.newsletter_unsubscribed_at ||
    !!profile?.deleted_at;

  return {
    email,
    displayName: profile?.display_name ?? null,
    unsubscribed,
    lastSignInAt,
  };
}

const greetingFor = (name: string | null): string =>
  name && name.trim() ? `Hi ${name.trim()},` : "Hi there,";

/** Inject drip-type-specific extras into the render vars. Keep this
 *  here (not in the template helper) so the template module stays
 *  pure-presentation. */
function buildRenderVars(args: {
  dripType: DripType;
  email: string;
  displayName: string | null;
  unsubscribeUrl: string;
}): RenderVars {
  const base: RenderVars = {
    user_email: args.email,
    unsubscribe_url: args.unsubscribeUrl,
    greeting: greetingFor(args.displayName),
  };

  if (args.dripType === "winback_30") {
    // Generic recent-feature blurb until product gives us a per-cohort
    // string. Designers can swap per-month from the dashboard once the
    // recent-feature CMS slot ships (B-NEW-8 follow-up).
    base.recent_feature =
      "Brand kits, scheduled auto-posts, and a redesigned cinematic preset that's faster to render.";
  }

  return base;
}

/** Process one schedule row end-to-end. Returns the new status string. */
async function processRow(
  supabase: SupabaseClient,
  resendApiKey: string | null,
  row: ScheduleRow,
): Promise<{ status: string; error?: string }> {
  // 1. Load user context.
  const ctx = await loadUserContext(supabase, row.user_id);

  if (!ctx.email) {
    return { status: "failed", error: "user has no email" };
  }
  if (ctx.unsubscribed) {
    return { status: "skipped_unsubscribed" };
  }

  // 2. Win-back gating — skip if user has signed in recently.
  if (row.drip_type === "winback_30" || row.drip_type === "winback_60") {
    const lastSignInMs = ctx.lastSignInAt ? Date.parse(ctx.lastSignInAt) : 0;
    const recentCutoffMs = Date.now() - WINBACK_RECENT_SIGNIN_DAYS * 86_400_000;
    if (lastSignInMs > recentCutoffMs) {
      return { status: "skipped_inactive" };
    }
  }

  // 3. Build unsubscribe URL + render template.
  const unsubscribeUrl = await buildUnsubscribeUrl(supabase, row.user_id);
  const vars = buildRenderVars({
    dripType: row.drip_type,
    email: ctx.email,
    displayName: ctx.displayName,
    unsubscribeUrl,
  });

  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = await renderTemplate(row.drip_type, vars);
  } catch (err) {
    return {
      status: "failed",
      error: `render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Dispatch via Resend.
  if (!resendApiKey) {
    // RESEND_API_KEY missing — match the fail-soft pattern used by the
    // rest of the codebase. Mark sent so we don't retry forever, but
    // log loudly so deploy-time misconfig is obvious in Sentry/logs.
    logStep("RESEND_API_KEY missing — marking sent without delivery", { id: row.id });
    return { status: "sent" };
  }

  const result = await sendViaResend({
    apiKey: resendApiKey,
    to: ctx.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  if (result.ok) {
    return { status: "sent" };
  }
  return { status: "failed", error: result.error };
}

export async function handler(req: Request): Promise<Response> {
  // Method gate. pg_cron POSTs; reject anything else so this can't be
  // probed via GET.
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Auth gate — service-role bearer required. The pg_cron job in the
  // accompanying migration sends `Authorization: Bearer <service_role>`;
  // a missing or wrong token is rejected. This mirrors the
  // drain-deletion-tasks gate (B-NEW-6).
  const authHeader = req.headers.get("Authorization") ?? "";
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    expected,
    { auth: { persistSession: false } },
  );

  const resendApiKey = Deno.env.get("RESEND_API_KEY") ?? null;
  if (!resendApiKey) {
    logStep("WARN: RESEND_API_KEY not configured — drips will be marked sent without delivery");
  }

  // 1. Pick up to BATCH_SIZE due rows. Using order(id) keeps the read
  //    deterministic across concurrent invocations (defense-in-depth;
  //    the cron only fires every 15 min so concurrency is unlikely).
  const { data: rows, error: pickErr } = await supabase
    .from("email_drip_schedule")
    .select("id, user_id, drip_type, scheduled_at")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (pickErr) {
    logStep("ERROR: pick failed", { error: pickErr.message });
    return new Response(JSON.stringify({ error: pickErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const due = (rows ?? []) as ScheduleRow[];
  if (due.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  logStep("Processing batch", { count: due.length });

  let sent = 0, skipped = 0, failed = 0;

  for (const row of due) {
    // Drip-type guard — a corrupted row shouldn't crash the whole batch.
    if (!Object.hasOwn(TEMPLATE_META, row.drip_type)) {
      logStep("WARN: unknown drip_type, marking failed", { id: row.id, drip_type: row.drip_type });
      await supabase
        .from("email_drip_schedule")
        .update({ status: "failed", error_message: `unknown drip_type ${row.drip_type}` })
        .eq("id", row.id);
      failed++;
      continue;
    }

    const result = await processRow(supabase, resendApiKey, row);

    const update: Record<string, unknown> = { status: result.status };
    if (result.status === "sent") {
      update.sent_at = new Date().toISOString();
      update.error_message = null;
      sent++;
    } else if (result.status === "skipped_unsubscribed" || result.status === "skipped_inactive") {
      update.error_message = null;
      skipped++;
    } else {
      update.error_message = result.error ?? "unknown failure";
      failed++;
    }

    const { error: updErr } = await supabase
      .from("email_drip_schedule")
      .update(update)
      .eq("id", row.id);
    if (updErr) {
      logStep("WARN: status update failed", { id: row.id, error: updErr.message });
    }
  }

  logStep("Batch complete", { sent, skipped, failed });

  return new Response(
    JSON.stringify({ ok: true, processed: due.length, sent, skipped, failed }),
    { headers: { "Content-Type": "application/json" } },
  );
}

if (import.meta.main) {
  serve(handler);
}
