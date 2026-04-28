/**
 * Worker handler for the `autopost_email_delivery` job type.
 *
 * Triggered by the autopost_on_video_completed Postgres trigger when an
 * autopost render finishes for a schedule with delivery_method='email'.
 * Sends one email per recipient with a 7-day signed URL to the rendered
 * video, then flips the run to 'completed'.
 *
 * Why a worker job (not an Edge Function): the rest of the autopost
 * pipeline runs on Render via this worker, including the publish
 * dispatcher. Keeping email here gives us a single operational pattern
 * (poll → claim → run → log) and lets us reuse writeSystemLog and the
 * service-role supabase client. Resend's REST API is plain `fetch` so
 * there's no Deno-specific SDK to port.
 *
 * Per-recipient failures DO NOT throw: we log a warning and keep
 * delivering. If Resend rejects every recipient we still flip the run to
 * 'completed' (the video itself rendered fine — email failure is a
 * downstream issue the user can retry separately).
 */

import { supabase } from "../../lib/supabase.js";
import { writeSystemLog } from "../../lib/logger.js";

interface EmailDeliveryPayload {
  autopost_run_id: string;
  recipients: string[];
  video_job_id: string;
}

export interface EmailDeliveryResult {
  delivered: number;
  recipients: number;
  runId: string;
}

const RESEND_API_URL = "https://api.resend.com/emails";
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Minimal HTML escape so we can safely interpolate user-typed prompts and
 *  schedule names into the email body without opening an injection vector. */
function escapeHtml(s: string): string {
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

/** If the stored URL is a bare storage path (e.g. "exports/foo.mp4"),
 *  sign it against the videos bucket so the recipient can fetch it.
 *  Mirrors dispatcher.ts:ensureFetchableVideoUrl but with a 7-day TTL. */
async function signIfStoragePath(raw: string): Promise<string> {
  if (!raw) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;

  const knownBuckets = ["videos", "scene-videos", "scene-images", "audio"];
  let bucket = "videos";
  let path = raw;
  for (const b of knownBuckets) {
    if (raw.startsWith(`${b}/`)) {
      bucket = b;
      path = raw.slice(b.length + 1);
      break;
    }
  }

  try {
    const { data, error } = await supabase
      .storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      console.warn(`[Autopost email] sign failed for "${raw}": ${error?.message ?? "no signedUrl"}`);
      return raw;
    }
    return data.signedUrl;
  } catch (e) {
    console.warn(`[Autopost email] sign exception for "${raw}": ${e instanceof Error ? e.message : String(e)}`);
    return raw;
  }
}

export async function handleAutopostEmailDelivery(
  jobId: string,
  payload: EmailDeliveryPayload,
  userId: string,
): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  // Default to Resend's testing domain so a missing RESEND_FROM_EMAIL
  // doesn't crash; the operator should configure motionmax.io once a
  // verified domain is set up. The format "Display Name <addr>" is what
  // Resend expects for a friendly sender label.
  const fromAddress =
    process.env.RESEND_FROM_EMAIL?.trim() || "MotionMax <onboarding@resend.dev>";

  if (!apiKey) {
    throw new Error("RESEND_API_KEY not configured on the worker");
  }
  if (!Array.isArray(payload?.recipients) || payload.recipients.length === 0) {
    throw new Error("autopost_email_delivery: recipients list is empty");
  }
  if (!payload.autopost_run_id) {
    throw new Error("autopost_email_delivery: missing autopost_run_id");
  }
  if (!payload.video_job_id) {
    throw new Error("autopost_email_delivery: missing video_job_id");
  }

  // ── Load run + schedule + the rendered video URL ───────────────────
  const { data: run, error: runErr } = await supabase
    .from("autopost_runs")
    .select("id, schedule_id, prompt_resolved, video_job_id, thumbnail_url")
    .eq("id", payload.autopost_run_id)
    .maybeSingle();
  if (runErr || !run) {
    throw new Error(`autopost_email_delivery: run not found (${runErr?.message ?? "no row"})`);
  }

  const { data: schedule } = await supabase
    .from("autopost_schedules")
    .select("name, prompt_template")
    .eq("id", (run as { schedule_id: string }).schedule_id)
    .maybeSingle();
  const scheduleName =
    (schedule as { name?: string } | null)?.name ?? "MotionMax";

  const { data: videoJob } = await supabase
    .from("video_generation_jobs")
    .select("payload, result")
    .eq("id", payload.video_job_id)
    .maybeSingle();

  const result =
    (videoJob as { result?: { finalUrl?: string; videoUrl?: string } | null } | null)?.result ?? null;
  const innerPayload =
    (videoJob as { payload?: { finalUrl?: string; videoUrl?: string } | null } | null)?.payload ?? null;
  const rawVideoUrl =
    result?.finalUrl ?? result?.videoUrl ?? innerPayload?.finalUrl ?? innerPayload?.videoUrl ?? "";
  if (!rawVideoUrl) {
    throw new Error("autopost_email_delivery: rendered video URL missing from job result");
  }
  const signedUrl = await signIfStoragePath(rawVideoUrl);

  const promptText = (run as { prompt_resolved?: string }).prompt_resolved ?? "";
  const thumbnailUrl = (run as { thumbnail_url?: string | null }).thumbnail_url ?? null;

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_email_delivery_started",
    message: `Sending video to ${payload.recipients.length} recipient(s)`,
    details: {
      runId: (run as { id: string }).id,
      recipients: payload.recipients.length,
      scheduleId: (run as { schedule_id: string }).schedule_id,
    },
  });

  // ── Per-recipient send loop ────────────────────────────────────────
  let delivered = 0;
  for (const to of payload.recipients) {
    const safeName = escapeHtml(scheduleName);
    const safePrompt = escapeHtml(promptText);

    const html = `<!doctype html>
<html>
  <body style="font-family: system-ui, -apple-system, sans-serif; background:#0A0D0F; color:#ECEAE4; padding:24px; margin:0;">
    <div style="max-width:560px; margin:0 auto; background:#10151A; border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:32px;">
      <h1 style="font-size:20px; margin:0 0 12px; color:#11C4D0; font-weight:600;">Your video is ready</h1>
      <p style="font-size:14px; color:#8A9198; margin:0 0 16px;">From your automation: <strong style="color:#ECEAE4;">${safeName}</strong></p>
      <p style="font-size:13px; color:#ECEAE4; margin:0 0 24px; line-height:1.55;">${safePrompt}</p>
      ${thumbnailUrl ? `<img src="${thumbnailUrl}" alt="" style="width:100%; border-radius:8px; margin-bottom:24px;" />` : ""}
      <a href="${signedUrl}" style="display:inline-block; background:#11C4D0; color:#0A0D0F; padding:12px 20px; border-radius:8px; text-decoration:none; font-weight:600;">Watch / download video</a>
      <p style="font-size:12px; color:#5A6268; margin:24px 0 0;">This link is valid for 7 days. Generated by MotionMax.</p>
    </div>
  </body>
</html>`;

    const text = `Your video is ready.

Automation: ${scheduleName}
Prompt: ${promptText}

Watch / download: ${signedUrl}

(Link valid 7 days)
— MotionMax`;

    let res: Response;
    try {
      res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to,
          subject: `Your MotionMax video is ready — ${scheduleName}`,
          html,
          text,
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeSystemLog({
        jobId,
        userId,
        category: "system_warning",
        eventType: "autopost_email_delivery_recipient_failed",
        message: `Resend transport error for ${to}: ${msg}`,
        details: { recipient: to, error: msg },
      });
      continue;
    }

    if (res.ok) {
      delivered += 1;
    } else {
      const body = await res.text().catch(() => "");
      await writeSystemLog({
        jobId,
        userId,
        category: "system_warning",
        eventType: "autopost_email_delivery_recipient_failed",
        message: `Resend rejected delivery to ${to}: ${res.status}`,
        details: { recipient: to, status: res.status, body: body.slice(0, 500) },
      });
    }
  }

  // ── Flip the run to completed, log, return ────────────────────────
  const runId = (run as { id: string }).id;
  await supabase
    .from("autopost_runs")
    .update({ status: "completed" })
    .eq("id", runId);

  await writeSystemLog({
    jobId,
    userId,
    category: "system_info",
    eventType: "autopost_email_delivery_completed",
    message: `Delivered video to ${delivered}/${payload.recipients.length} recipient(s)`,
    details: { runId, delivered, recipients: payload.recipients.length },
  });

  return { delivered, recipients: payload.recipients.length, runId };
}
