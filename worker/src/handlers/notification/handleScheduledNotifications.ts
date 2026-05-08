/**
 * Scheduled-notification dispatcher (Phase 14.3).
 *
 * user_notifications rows can be inserted with `scheduled_for > now()`
 * and `delivered_at IS NULL` — admin_schedule_notification creates
 * those, and snooze_notification re-arms them. This loop polls every
 * 30 s and flips matured rows to `delivered_at = now()` so the user's
 * realtime channel picks them up.
 *
 * No Resend dispatch by default — push notifications land in-app.
 * Email digest hook (notification_channels.email.digest_to) is opt-in
 * and runs as a separate batched flush (Phase 18).
 */
import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

const POLL_INTERVAL_MS = 30_000;
let running = false;

export function startScheduledNotificationDispatcher(): void {
  if (running) return;
  running = true;
  const tick = async (): Promise<void> => {
    try {
      const { data, error } = await supabase
        .from("user_notifications")
        .update({ delivered_at: new Date().toISOString() })
        .is("delivered_at", null)
        .lte("scheduled_for", new Date().toISOString())
        .select("id, user_id, severity")
        .limit(500);
      if (error) {
        console.warn(`[ScheduledNotifications] tick error: ${error.message}`);
        return;
      }
      const list = (data as Array<{ id: string; user_id: string; severity: string }> | null) ?? [];
      if (list.length > 0) {
        await writeSystemLog({
          category: "system_info",
          eventType: "scheduled_notifications_delivered",
          message: `Delivered ${list.length} scheduled notification(s)`,
          details: { count: list.length, by_severity: countBy(list.map((r) => r.severity)) },
        });
      }
    } catch (err) {
      console.warn(`[ScheduledNotifications] exception: ${(err as Error).message}`);
    }
  };
  void tick();
  setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  console.log(`[ScheduledNotifications] dispatcher started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
}

function countBy(arr: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of arr) out[v] = (out[v] ?? 0) + 1;
  return out;
}
