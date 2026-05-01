/**
 * Autopost daily summary task.
 *
 * Wave 4 (production hardening). Fires once per UTC day at 09:00 UTC.
 * Iterates over each user that had any autopost activity in the last 24
 * hours, aggregates their per-platform roll-up via the
 * `autopost_daily_summary` RPC, and emits a single structured-log entry
 * per user via writeSystemLog. As of the production-readiness ship,
 * also delivers the summary as a real email through Resend (same
 * transport pattern as handleEmailDelivery.ts).
 *
 * Design notes:
 *   - `setInterval` once per hour, gated by `getUTCHours() === 9`. We
 *     accept that this fires once per worker replica; the soft-launch
 *     scope is single-tenant so dedup across replicas is YAGNI.
 *   - Email transport: Resend REST API. Same key (RESEND_API_KEY) and
 *     from address (RESEND_FROM_EMAIL) as the per-run delivery email,
 *     with a separate per-user-per-day cap enforced by checking
 *     system_logs for an existing autopost_daily_summary_email_sent
 *     event for the same (userId, day) pair before sending.
 *   - Recipient: pulled via supabase.auth.admin.getUserById() against
 *     the user's id. profiles.notify_daily_summary doesn't exist yet
 *     (TODO: add column), so we default ON for everyone with at least
 *     one delivery_method='email' schedule that fired the run set —
 *     that gates spam to users who didn't already opt into autopost
 *     email delivery.
 *   - Empty-digest guard: `runSummaryForDay` already filters users
 *     down to "had any autopost run." We additionally skip the email
 *     when totalAttempts === 0 (e.g. all runs failed before producing
 *     any publish_jobs row) so we never send a "0 attempts" email.
 *   - Scope = "users with any autopost run fired in the last 24h." That
 *     gives us the right denominator (users who SHOULD see a summary)
 *     and avoids spamming users who paused all schedules yesterday.
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

const RESEND_API_URL = "https://api.resend.com/emails";

/** Minimal HTML escape so we can safely interpolate user-typed schedule
 *  names and platform identifiers into the email body. */
function escapeHtmlSummary(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default:  return c;
    }
  });
}

const ONE_HOUR_MS = 60 * 60_000;
const TARGET_UTC_HOUR = 9;

let started = false;
/**
 * Tracks the UTC date string of the last summary run so a single worker
 * process never sends two summaries in one day even if the hour-tick
 * fires twice (clock jitter, timer drift). The string format is the
 * same UTC YYYY-MM-DD we use as the metrics bucket key.
 */
let lastSentForDate: string | null = null;

export function startAutopostDailySummary(): void {
  if (started) return;
  started = true;
  // Hourly tick. We don't run immediately on boot — that would fire a
  // summary every time the worker restarts, which would be noisy. The
  // first opportunity is the next top-of-hour hit.
  setInterval(maybeRunSummary, ONE_HOUR_MS);
}

async function maybeRunSummary(): Promise<void> {
  try {
    const now = new Date();
    if (now.getUTCHours() !== TARGET_UTC_HOUR) return;

    // The summary covers YESTERDAY (UTC). At 09:00 UTC the previous UTC
    // day is fully closed and its bucket row is final.
    const yesterday = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 1,
    ));
    const day = yesterday.toISOString().slice(0, 10);

    if (lastSentForDate === day) return;
    lastSentForDate = day;

    await runSummaryForDay(day);
  } catch (e) {
    console.error(`[Autopost] daily summary tick failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Exported for the manual kill-switch drill helper / future ad-hoc invocation. */
export async function runSummaryForDay(day: string): Promise<void> {
  // Find every user with at least one autopost run fired during the target
  // UTC day. We go through autopost_runs (not autopost_platform_metrics)
  // because that gives us the right denominator: a user with 5 scheduled
  // runs and 0 publishes still deserves a "0 published, 5 attempted"
  // summary so they notice the failure pattern.
  const dayStart = `${day}T00:00:00Z`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * ONE_HOUR_MS).toISOString();

  const { data: runs, error: runsErr } = await supabase
    .from("autopost_runs")
    .select("id, schedule_id, autopost_schedules!inner(user_id)")
    .gte("fired_at", dayStart)
    .lt("fired_at", dayEnd);

  if (runsErr) {
    console.warn(`[Autopost] daily summary: runs query failed: ${runsErr.message}`);
    return;
  }
  if (!runs || runs.length === 0) {
    await writeSystemLog({
      category: "system_info",
      eventType: "autopost_daily_summary_empty",
      message: `No autopost activity for ${day}; no summaries emitted`,
      details: { day },
    });
    return;
  }

  // Distinct user ids from the joined schedule rows.
  const userIds = new Set<string>();
  for (const r of runs as Array<{ autopost_schedules?: { user_id?: string } | { user_id?: string }[] }>) {
    const sched = r.autopost_schedules;
    // Supabase returns the joined row as an object when the relation is
    // 1-to-1 and as an array when it can't infer cardinality. Handle both.
    if (Array.isArray(sched)) {
      for (const s of sched) if (s.user_id) userIds.add(s.user_id);
    } else if (sched && sched.user_id) {
      userIds.add(sched.user_id);
    }
  }

  for (const userId of userIds) {
    try {
      await emitUserSummary(userId, day);
    } catch (e) {
      console.warn(`[Autopost] daily summary: user ${userId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function emitUserSummary(userId: string, day: string): Promise<void> {
  const { data, error } = await supabase.rpc("autopost_daily_summary", {
    p_user_id: userId,
    p_day: day,
  });

  if (error) {
    console.warn(`[Autopost] daily summary RPC failed for user ${userId}: ${error.message}`);
    return;
  }

  type Row = { platform: string; succeeded: number; failed: number; total_attempts: number };
  const rows = (data as Row[] | null) ?? [];

  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalAttempts = 0;
  const perPlatform: Record<string, { succeeded: number; failed: number; total_attempts: number }> = {};
  for (const row of rows) {
    totalSucceeded += row.succeeded;
    totalFailed += row.failed;
    totalAttempts += row.total_attempts;
    perPlatform[row.platform] = {
      succeeded: row.succeeded,
      failed: row.failed,
      total_attempts: row.total_attempts,
    };
  }

  // Plain-text summary body. When email transport lands later, this is the
  // exact body the email will carry — keep it human-readable.
  const lines: string[] = [];
  lines.push(`MotionMax autopost summary — ${day}`);
  lines.push("");
  lines.push(`Total attempts: ${totalAttempts}`);
  lines.push(`Succeeded:      ${totalSucceeded}`);
  lines.push(`Failed:         ${totalFailed}`);
  lines.push("");
  if (rows.length === 0) {
    lines.push("No publishes recorded — schedules may have been paused or the kill-switch was off.");
  } else {
    lines.push("By platform:");
    for (const row of rows) {
      lines.push(`  ${row.platform.padEnd(10)} ${row.succeeded}\u2713  ${row.failed}\u2717  (${row.total_attempts} attempts)`);
    }
  }
  const body = lines.join("\n");

  await writeSystemLog({
    userId,
    category: "system_info",
    eventType: "autopost_daily_summary",
    message: `Autopost daily summary for ${day}: ${totalSucceeded} succeeded, ${totalFailed} failed, ${totalAttempts} attempts`,
    details: {
      userId,
      day,
      succeeded: totalSucceeded,
      failed: totalFailed,
      totalAttempts,
      perPlatform,
      body,
    },
  });

  // ── Email transport ───────────────────────────────────────────────
  // Empty-digest guard: skip the email when there were no publish
  // outcomes at all. Even though runSummaryForDay scopes us to "users
  // with at least one autopost run," a user whose runs all failed
  // before reaching the publish_jobs fan-out shows up here with
  // totalAttempts === 0 — sending them a "0 attempts" email is just
  // noise.
  if (totalAttempts === 0) return;

  // Eligibility gate: only deliver to users who have at least one
  // delivery_method='email' autopost schedule. They've already opted
  // into autopost emails by setting that delivery method, so a daily
  // summary on top of per-run emails is a fair extension. Users on
  // library-only or platform-publish-only schedules don't get
  // summaries until profiles.notify_daily_summary lands as a real
  // opt-in column.
  // TODO: add profiles.notify_daily_summary boolean (default ON) and
  // honour that in addition to (or instead of) the delivery_method
  // gate so users can disable summary emails without losing per-run
  // delivery. Default ON per ship-plan instructions.
  const { count: emailScheduleCount, error: schedErr } = await supabase
    .from("autopost_schedules")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("delivery_method", "email");
  if (schedErr) {
    console.warn(`[Autopost] daily summary: schedule check failed for ${userId}: ${schedErr.message}`);
    return;
  }
  if (!emailScheduleCount || emailScheduleCount === 0) return;

  // Per-user-per-day cap. The cron tick can fire from multiple worker
  // replicas (each maintains its own lastSentForDate); the
  // system_logs lookup is the cross-replica dedupe.
  const { count: alreadySentCount } = await supabase
    .from("system_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("event_type", "autopost_daily_summary_email_sent")
    .contains("details", { day });
  if (alreadySentCount && alreadySentCount > 0) {
    return; // silent — already mailed today
  }

  // Recipient lookup. Service-role key allows admin auth API.
  let recipientEmail = "";
  try {
    const { data: userRow, error: userErr } = await supabase.auth.admin.getUserById(userId);
    if (userErr) {
      console.warn(`[Autopost] daily summary: getUserById failed for ${userId}: ${userErr.message}`);
      return;
    }
    recipientEmail = userRow?.user?.email ?? "";
  } catch (e) {
    console.warn(`[Autopost] daily summary: getUserById exception for ${userId}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!recipientEmail) return; // user has no email on auth row — nothing to send to

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.warn(`[Autopost] daily summary: RESEND_API_KEY missing — skipping email send for ${userId}`);
    return;
  }
  const rawFrom = process.env.RESEND_FROM_EMAIL?.trim() || "";
  const fromAddress = rawFrom || "MotionMax <onboarding@resend.dev>";

  const appUrl = (process.env.APP_URL || "https://www.motionmax.io").replace(/\/+$/, "");

  const platformRowsHtml = rows
    .map((r) => {
      const p = escapeHtmlSummary(r.platform);
      return `<tr>
        <td style="padding:6px 12px;color:#ECEAE4;">${p}</td>
        <td style="padding:6px 12px;color:#11C4D0;text-align:right;">${r.succeeded}</td>
        <td style="padding:6px 12px;color:#E4C875;text-align:right;">${r.failed}</td>
        <td style="padding:6px 12px;color:#8A9198;text-align:right;">${r.total_attempts}</td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0A0D0F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ECEAE4;">
    <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
        <tr>
          <td style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#ECEAE4;letter-spacing:0.2px;">
            <span style="color:#11C4D0;">Motion</span><span style="color:#E4C875;">Max</span>
          </td>
          <td align="right" style="font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:#5A6268;">
            Daily Summary
          </td>
        </tr>
      </table>
      <div style="background:#10151A;border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;padding:28px;">
        <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#11C4D0;">Autopost summary</p>
        <h1 style="margin:0 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;line-height:1.25;color:#ECEAE4;">${escapeHtmlSummary(day)}</h1>
        <p style="margin:0 0 22px;font-size:13px;color:#8A9198;">${totalSucceeded} succeeded \u00b7 ${totalFailed} failed \u00b7 ${totalAttempts} attempts</p>
        ${rows.length > 0 ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <thead>
            <tr>
              <th align="left"  style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#5A6268;">Platform</th>
              <th align="right" style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#5A6268;">Succeeded</th>
              <th align="right" style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#5A6268;">Failed</th>
              <th align="right" style="padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#5A6268;">Attempts</th>
            </tr>
          </thead>
          <tbody>${platformRowsHtml}</tbody>
        </table>` : `<p style="margin:8px 0 0;font-size:13px;color:#8A9198;">No publishes recorded \u2014 schedules may have been paused or the kill-switch was off.</p>`}
      </div>
      <p style="margin:18px 0 0;font-size:11px;color:#5A6268;text-align:center;line-height:1.6;">
        Manage your automations at
        <a href="${appUrl}/lab/autopost" style="color:#8A9198;text-decoration:underline;">${appUrl.replace(/^https?:\/\//, "")}/lab/autopost</a>.
      </p>
    </div>
  </body>
</html>`;

  let res: Response | null = null;
  let lastErr: string | null = null;
  let lastBody = "";
  // 3-attempt exponential backoff, identical policy to handleEmailDelivery.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
    try {
      res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: recipientEmail,
          subject: `MotionMax autopost summary \u2014 ${day}`,
          html,
          text: body,
        }),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      res = null;
      continue;
    }
    if (res.ok) break;
    lastBody = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
  }

  if (res && res.ok) {
    await writeSystemLog({
      userId,
      category: "system_info",
      eventType: "autopost_daily_summary_email_sent",
      message: `Daily summary email sent to ${recipientEmail} for ${day}`,
      details: { userId, day, recipient: recipientEmail, totalAttempts, totalSucceeded, totalFailed },
    });
  } else if (res === null) {
    await writeSystemLog({
      userId,
      category: "system_warning",
      eventType: "autopost_daily_summary_email_failed",
      message: `Resend transport error sending daily summary to ${recipientEmail}: ${lastErr ?? "unknown"}`,
      details: { userId, day, recipient: recipientEmail, error: lastErr },
    });
  } else {
    await writeSystemLog({
      userId,
      category: "system_warning",
      eventType: "autopost_daily_summary_email_failed",
      message: `Resend rejected daily summary to ${recipientEmail}: ${res.status}`,
      details: { userId, day, recipient: recipientEmail, status: res.status, body: lastBody.slice(0, 500) },
    });
  }
}
