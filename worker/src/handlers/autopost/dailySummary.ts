/**
 * Autopost daily summary task.
 *
 * Wave 4 (production hardening). Fires once per UTC day at 09:00 UTC.
 * Iterates over each user that had any autopost activity in the last 24
 * hours, aggregates their per-platform roll-up via the
 * `autopost_daily_summary` RPC, and emits a single structured-log entry
 * per user via writeSystemLog.
 *
 * Design notes:
 *   - `setInterval` once per hour, gated by `getUTCHours() === 9`. We
 *     accept that this fires once per worker replica; the soft-launch
 *     scope is single-tenant so dedup across replicas is YAGNI.
 *   - We deliberately do NOT ship a real email transport in this wave.
 *     The supabase/functions/_shared/resend.ts helper is Deno-only and
 *     can't be imported from Node. When Jo wires SendGrid/Resend (per
 *     the AUTOPOST_PLAN.md §14 outstanding-work list) the only change
 *     here is to add a transport call alongside the writeSystemLog.
 *   - Scope = "users with any autopost run fired in the last 24h." That
 *     gives us the right denominator (users who SHOULD see a summary)
 *     and avoids spamming users who paused all schedules yesterday.
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

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
      lines.push(`  ${row.platform.padEnd(10)} ${row.succeeded}✓  ${row.failed}✗  (${row.total_attempts} attempts)`);
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
}
