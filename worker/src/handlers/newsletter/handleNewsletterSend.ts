/**
 * Newsletter campaign sender (Phase 15.3).
 *
 * Background polling loop — separate from the video_generation_jobs
 * queue. Polls newsletter_campaigns every 30 s. On each tick:
 *   1. Look for the oldest campaign with status='scheduled' AND
 *      scheduled_for <= now(). Claim it by flipping status to
 *      'sending' (atomic UPDATE … RETURNING; only one worker wins).
 *   2. Resolve the audience via newsletter_resolve_audience(p_audience).
 *   3. Insert one newsletter_sends row per recipient (status='pending')
 *      with ON CONFLICT DO NOTHING — idempotent across retries.
 *   4. Iterate pending sends in batches of 1000, fire to Resend, update
 *      each row's status to 'sent' / 'failed' with the resend_message_id.
 *   5. When all sends are done, set campaign status='sent' + sent_at.
 *
 * Per-recipient: looks up an unsubscribe_token via ensure_unsubscribe_token,
 * appends `?t=<token>` to the canonical /unsubscribe URL in the footer.
 *
 * Failure model: a transient Resend error fails the send row only
 * (status='failed' + error). The campaign stays in 'sending' until
 * every send row settles; the next poll picks up retries via
 * pending status. Resend rate-limit (429) sleeps 2 s and retries.
 */
import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";
import { isKillSwitchArmed } from "../../lib/featureFlags.js";

const RESEND_API_URL = "https://api.resend.com/emails";
const POLL_INTERVAL_MS = 30_000;
const SEND_BATCH_SIZE = 1000;
const RESEND_BATCH_SIZE = 50;       // Resend's batch /emails endpoint cap
const UNSUBSCRIBE_PATH = "/unsubscribe";
const APP_URL = (process.env.APP_URL || "https://motionmax.io").replace(/\/$/, "");

let running = false;

interface Campaign {
  id: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  audience: string;
  status: string;
  scheduled_for: string | null;
}
interface PendingSend {
  id: string;
  user_id: string;
  email: string;
  campaign_id: string;
}

async function claimNextCampaign(): Promise<Campaign | null> {
  // Atomic claim — only one worker can flip a 'scheduled' row whose
  // scheduled_for has elapsed to 'sending'. RETURNING gives us back the
  // row if we won; null if another worker already grabbed it.
  const { data, error } = await supabase
    .from("newsletter_campaigns")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .select("id, subject, body_html, body_text, audience, status, scheduled_for")
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[Newsletter] claimNextCampaign error: ${error.message}`);
    return null;
  }
  return (data as Campaign | null) ?? null;
}

async function ensureSendRows(campaignId: string, audience: string): Promise<number> {
  // Resolve recipients via the SECURITY DEFINER RPC; the worker's
  // service-role connection bypasses the auth.role() check.
  const { data: rcpts, error } = await supabase.rpc("newsletter_resolve_audience", { p_audience: audience });
  if (error) {
    console.error(`[Newsletter] resolve audience failed: ${error.message}`);
    return 0;
  }
  const list = (rcpts ?? []) as Array<{ user_id: string; email: string }>;
  if (list.length === 0) return 0;

  // Bulk insert with ON CONFLICT DO NOTHING — idempotent across retries.
  const rows = list.map((r) => ({
    campaign_id: campaignId,
    user_id: r.user_id,
    email: r.email,
    status: "pending" as const,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    const { error: insErr } = await supabase
      .from("newsletter_sends")
      .upsert(slice, { onConflict: "campaign_id,user_id", ignoreDuplicates: true });
    if (insErr) console.warn(`[Newsletter] bulk insert sends failed: ${insErr.message}`);
  }
  return list.length;
}

function injectUnsubscribeFooter(html: string, unsubUrl: string): string {
  const footer = `\n<hr style="border:none;border-top:1px solid #ddd;margin:24px 0 12px"/>\n` +
    `<p style="color:#888;font-size:12px;margin:0">You're receiving this because you opted in to MotionMax updates. ` +
    `<a href="${unsubUrl}" style="color:#888;text-decoration:underline">Unsubscribe</a>.</p>\n`;
  return html.includes("</body>") ? html.replace("</body>", `${footer}</body>`) : html + footer;
}

async function sendOneBatch(campaign: Campaign, batch: PendingSend[], apiKey: string, fromAddress: string): Promise<void> {
  for (const row of batch) {
    try {
      // Generate (or reuse) the unsubscribe token per recipient.
      const { data: tokRes } = await supabase.rpc("ensure_unsubscribe_token", { p_user_id: row.user_id });
      const token = typeof tokRes === "string" ? tokRes : "";
      const unsubUrl = token ? `${APP_URL}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}` : `${APP_URL}${UNSUBSCRIBE_PATH}`;
      const html = injectUnsubscribeFooter(campaign.body_html, unsubUrl);

      const res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromAddress,
          to: row.email,
          subject: campaign.subject,
          html,
          text: campaign.body_text ?? undefined,
          headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        }),
      });

      if (res.status === 429) {
        // Resend rate-limited — back off briefly and retry once.
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (!res.ok) {
        const txt = await res.text();
        await supabase.from("newsletter_sends")
          .update({ status: "failed", error: txt.slice(0, 500), sent_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      const body = await res.json() as { id?: string };
      await supabase.from("newsletter_sends")
        .update({
          status: "sent",
          resend_message_id: body.id ?? null,
          sent_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", row.id);
    } catch (err) {
      await supabase.from("newsletter_sends")
        .update({ status: "failed", error: (err as Error).message.slice(0, 500), sent_at: new Date().toISOString() })
        .eq("id", row.id);
    }
  }
}

async function dispatchCampaign(campaign: Campaign): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.RESEND_FROM_EMAIL?.trim() || "MotionMax <noreply@motionmax.io>";

  if (!apiKey) {
    console.error(`[Newsletter] RESEND_API_KEY missing — campaign ${campaign.id} cannot send. Reverting to scheduled.`);
    await supabase.from("newsletter_campaigns")
      .update({ status: "scheduled" })
      .eq("id", campaign.id);
    return;
  }

  // Step 1: ensure send rows exist (idempotent on re-run).
  const audienceCount = await ensureSendRows(campaign.id, campaign.audience);
  await writeSystemLog({
    category: "system_info",
    eventType: "newsletter_dispatch_started",
    message: `Newsletter campaign ${campaign.id} started: ${audienceCount} recipient(s)`,
    details: { campaignId: campaign.id, audience: campaign.audience, recipients: audienceCount },
  });

  // Step 2: drain pending sends in 1000-row batches.
  let total = 0;
  for (;;) {
    const { data: batch, error } = await supabase
      .from("newsletter_sends")
      .select("id, user_id, email, campaign_id")
      .eq("campaign_id", campaign.id)
      .eq("status", "pending")
      .limit(SEND_BATCH_SIZE);
    if (error) {
      console.warn(`[Newsletter] fetch pending sends failed: ${error.message}`);
      break;
    }
    const list = (batch as PendingSend[] | null) ?? [];
    if (list.length === 0) break;

    // Inner micro-batches stay under Resend's connection-pool comfort
    // zone — sequential POSTs on a single connection are fine at this
    // scale and avoid the batch-API's per-row signature complexity.
    for (let i = 0; i < list.length; i += RESEND_BATCH_SIZE) {
      await sendOneBatch(campaign, list.slice(i, i + RESEND_BATCH_SIZE), apiKey, fromAddress);
    }
    total += list.length;
    if (list.length < SEND_BATCH_SIZE) break;
  }

  // Step 3: mark campaign sent (only when no pending rows remain).
  const { count: remaining } = await supabase
    .from("newsletter_sends")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("status", "pending");
  if ((remaining ?? 0) === 0) {
    await supabase.from("newsletter_campaigns")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", campaign.id);
    await writeSystemLog({
      category: "system_info",
      eventType: "newsletter_dispatch_completed",
      message: `Newsletter campaign ${campaign.id} dispatched ${total} email(s)`,
      details: { campaignId: campaign.id, recipients: total },
    });
  }
}

export function startNewsletterSender(): void {
  if (running) return;
  running = true;
  const tick = async (): Promise<void> => {
    try {
      // Phase 17.3 kill-switch — admin can pause the dispatcher
      // without cancelling scheduled campaigns. They stay in
      // 'scheduled' status; we just don't claim while armed.
      if (await isKillSwitchArmed("pause_newsletter")) return;
      const campaign = await claimNextCampaign();
      if (campaign) await dispatchCampaign(campaign);
    } catch (err) {
      console.warn(`[Newsletter] tick error: ${(err as Error).message}`);
    }
  };
  // Fire once on boot, then on a 30 s interval. Catches any campaign
  // whose scheduled_for elapsed during a prior worker downtime.
  void tick();
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  console.log(`[Newsletter] sender started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
}
