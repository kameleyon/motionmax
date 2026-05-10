/**
 * Queue depth alert — when pollQueue claims jobs and the total pending
 * queue exceeds the configured threshold, fan out an alert to one or
 * both webhook channels (legacy ALERT_WEBHOOK_URL + production
 * AUTOPOST_ALERT_WEBHOOK_URL) and write a system_warning row so the
 * admin tab's activity feed surfaces the event. Extracted from
 * worker/src/index.ts on 2026-05-10 (per audit C-4-3). Behavior is
 * preserved exactly: same payload shape, same console.warn, same
 * fire-and-forget never-throw semantics.
 */
import os from "os";
import { writeSystemLog } from "./logger.js";

export interface QueueDepthAlertSnapshot {
  totalPending: number;
  threshold: number;
  activeExportJobs: number;
  activeLlmJobs: number;
  maxExportSlots: number;
  maxLlmSlots: number;
  workerId: string;
}

export function emitQueueDepthAlert(snap: QueueDepthAlertSnapshot): void {
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1048576);

  console.warn(
    `[Worker] ⚠️ QUEUE DEPTH ALERT: ${snap.totalPending} pending jobs (threshold: ${snap.threshold}), ` +
    `active: export=${snap.activeExportJobs}/${snap.maxExportSlots} llm=${snap.activeLlmJobs}/${snap.maxLlmSlots}, ` +
    `RSS: ${rssMb}MB`
  );

  // Two webhook channels supported:
  //   - ALERT_WEBHOOK_URL: legacy generic alert sink (kept for
  //     back-compat — anything that already consumes our older
  //     `{ text, queue_depth }` payload).
  //   - AUTOPOST_ALERT_WEBHOOK_URL: production-readiness alert
  //     channel (Slack/Discord/PagerDuty incoming webhook). Uses
  //     the structured `[MotionMax]`-prefixed payload spec'd in
  //     the autopost ship plan so a single sink can fan out to
  //     ops without per-channel parsing.
  // Both are independent: setting one does not silence the other.
  // If neither is set, both branches no-op silently — never let a
  // missing webhook break a worker tick.
  const legacyAlertUrl = process.env.ALERT_WEBHOOK_URL;
  if (legacyAlertUrl) {
    fetch(legacyAlertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `MotionMax queue depth alert: ${snap.totalPending} jobs pending`,
        queue_depth: snap.totalPending,
      }),
    }).catch(() => {
      // Silently ignore webhook failures — never let an alert break the worker
    });
  }

  const autopostAlertUrl = process.env.AUTOPOST_ALERT_WEBHOOK_URL;
  if (autopostAlertUrl) {
    fetch(autopostAlertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `[MotionMax] Queue depth alert: ${snap.totalPending} pending`,
        details: {
          pendingJobs: snap.totalPending,
          threshold: snap.threshold,
          activeExportJobs: snap.activeExportJobs,
          activeLlmJobs: snap.activeLlmJobs,
          maxExportSlots: snap.maxExportSlots,
          maxLlmSlots: snap.maxLlmSlots,
          rssMb,
          workerId: snap.workerId,
        },
      }),
    }).catch(() => {
      // Silently ignore webhook failures — never let an alert break the worker
    });
  }

  writeSystemLog({
    category: "system_warning",
    eventType: "queue_depth_alert",
    message: `Queue depth ${snap.totalPending} exceeds threshold ${snap.threshold} — consider scaling workers`,
    details: {
      pendingJobs: snap.totalPending,
      activeExportJobs: snap.activeExportJobs,
      activeLlmJobs: snap.activeLlmJobs,
      maxExportSlots: snap.maxExportSlots,
      maxLlmSlots: snap.maxLlmSlots,
      rssMb,
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1048576),
    },
  }).catch((err) => { console.warn('[Worker] background log failed:', (err as Error).message); });
}
