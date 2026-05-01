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
    .select("id, schedule_id, topic, video_job_id, thumbnail_url")
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

  // Use the run's topic (one short clean line) for the email body, NOT
  // prompt_resolved — that field can be 150KB+ when the schedule has
  // attached sources, and dumping it into the email made the body
  // unreadable. Topic is what the user picked from the topic pool and
  // is the right summary for "your video about X is ready".
  const topicText = (run as { topic?: string | null }).topic ?? "";
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
  // Build URLs that point at motionmax.io rather than raw Supabase
  // URLs. vercel.json rewrites /api/video/:path* and
  // /api/media/:bucket/:path* through the Supabase serve-media edge
  // function, so we can proxy any storage path behind the brand
  // domain. This keeps every URL in the email on motionmax.io —
  // watch link, thumbnail, and direct-download link.
  const appUrl = (process.env.APP_URL || "https://www.motionmax.io").replace(/\/+$/, "");
  const runUrl = `${appUrl}/lab/autopost/runs/${(run as { id: string }).id}`;

  /** Convert a `https://<ref>.supabase.co/storage/v1/object/(public|sign)/<bucket>/<path>`
   *  URL into the equivalent `<appUrl>/api/media/<bucket>/<path>` proxy
   *  URL. Falls through unchanged for anything that doesn't match. */
  function brandedMediaUrl(input: string | null | undefined): string {
    if (!input) return "";
    try {
      const u = new URL(input);
      if (!u.hostname.endsWith(".supabase.co")) return input;
      // expected path: /storage/v1/object/(public|sign|...)/<bucket>/<path>
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 5 || parts[0] !== "storage") return input;
      // parts: ["storage", "v1", "object", "<mode>", "<bucket>", ...rest]
      const bucket = parts[4];
      const rest = parts.slice(5).join("/");
      if (!bucket || !rest) return input;
      return `${appUrl}/api/media/${encodeURI(bucket)}/${encodeURI(rest)}`;
    } catch {
      return input;
    }
  }

  const brandedDownloadUrl = brandedMediaUrl(signedUrl);
  const brandedThumbUrl = thumbnailUrl ? brandedMediaUrl(thumbnailUrl) : "";
  let delivered = 0;
  for (const to of payload.recipients) {
    const safeName = escapeHtml(scheduleName);
    const safeTopic = escapeHtml(topicText);
    const safeRunUrl = escapeHtml(runUrl);
    const safeSignedUrl = escapeHtml(brandedDownloadUrl);
    const safeThumb = brandedThumbUrl ? escapeHtml(brandedThumbUrl) : "";

    const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0A0D0F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ECEAE4;">
    <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
      <!-- header -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:16px;">
        <tr>
          <td style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#ECEAE4;letter-spacing:0.2px;">
            <span style="color:#11C4D0;">Motion</span><span style="color:#E4C875;">Max</span>
          </td>
          <td align="right" style="font-size:11px;text-transform:uppercase;letter-spacing:0.18em;color:#5A6268;">
            Autopost
          </td>
        </tr>
      </table>

      <!-- card -->
      <div style="background:#10151A;border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden;">
        ${safeThumb ? `
        <a href="${safeRunUrl}" style="display:block;background:#000;">
          <img src="${safeThumb}" alt="${safeTopic || safeName}" width="600" style="display:block;width:100%;height:auto;border:0;outline:none;text-decoration:none;" />
        </a>` : ""}

        <div style="padding:28px 28px 32px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.16em;color:#11C4D0;">Your video is ready</p>
          <h1 style="margin:0 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;line-height:1.25;color:#ECEAE4;">
            ${safeTopic || safeName}
          </h1>
          <p style="margin:0 0 22px;font-size:13px;color:#8A9198;">
            From <span style="color:#ECEAE4;">${safeName}</span>
          </p>

          <!-- primary CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">
            <tr>
              <td align="center" bgcolor="#11C4D0" style="border-radius:10px;">
                <a href="${safeRunUrl}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:600;color:#0A0D0F;text-decoration:none;letter-spacing:0.2px;">
                  Watch on MotionMax  &rarr;
                </a>
              </td>
            </tr>
          </table>

          <!-- secondary download link -->
          <p style="margin:0 0 4px;font-size:12px;color:#8A9198;">
            Or
            <a href="${safeSignedUrl}" style="color:#E4C875;text-decoration:underline;">download the video directly</a>
            (link valid for 7 days).
          </p>
        </div>
      </div>

      <!-- footer -->
      <p style="margin:18px 0 0;font-size:11px;color:#5A6268;text-align:center;line-height:1.6;">
        Generated automatically by your MotionMax automation.<br/>
        Manage or pause this schedule at
        <a href="${appUrl}/lab/autopost" style="color:#8A9198;text-decoration:underline;">${appUrl.replace(/^https?:\/\//, "")}/lab/autopost</a>.
      </p>
    </div>
  </body>
</html>`;

    const text = `Your MotionMax video is ready.

${topicText ? `Topic: ${topicText}\n` : ""}From: ${scheduleName}

Watch on MotionMax: ${runUrl}
Direct download (7 days): ${brandedDownloadUrl}

Manage this automation: ${appUrl}/lab/autopost
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
