const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "MotionMax <noreply@motionmax.io>";
const DEFAULT_SUPPORT = "MotionMax Support <support@motionmax.io>";

export const fromAddress = (): string =>
  Deno.env.get("RESEND_FROM_EMAIL") ?? DEFAULT_FROM;
export const supportFromAddress = (): string =>
  Deno.env.get("RESEND_SUPPORT_EMAIL") ?? DEFAULT_SUPPORT;

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  /** Override from-address (e.g. support@). Defaults to RESEND_FROM_EMAIL. */
  from?: string;
  /** Reply-To header — useful for support replies that should land in
   *  the user's inbox instead of noreply@. */
  replyTo?: string;
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[resend] RESEND_API_KEY not set — email skipped", { to: payload.to, subject: payload.subject });
    return;
  }

  const body: Record<string, unknown> = {
    from: payload.from ?? fromAddress(),
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  };
  if (payload.replyTo) body.reply_to = payload.replyTo;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("[resend] Failed to send email", { status: res.status, body: txt, to: payload.to });
  }
}

export async function sendWelcomeEmail(to: string, planName: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Welcome to MotionMax — your subscription is active",
    html: `
      <h2>You're all set!</h2>
      <p>Your <strong>${planName}</strong> plan is now active. Head to your
      <a href="https://motionmax.io/dashboard">dashboard</a> to start creating.</p>
      <p>Questions? Reply to this email — we're here to help.</p>
    `,
  });
}

export async function sendPaymentFailedEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Action required: payment failed on your MotionMax subscription",
    html: `
      <h2>We couldn't process your payment</h2>
      <p>Please update your payment method in your
      <a href="https://motionmax.io/settings">account settings</a> to keep your subscription active.</p>
      <p>Your account will remain accessible for a short grace period.</p>
    `,
  });
}

export async function sendSignupWelcomeEmail(to: string, displayName?: string): Promise<void> {
  const greeting = displayName?.trim() ? `Hi ${displayName.trim()}` : "Welcome";
  await sendEmail({
    to,
    subject: "Welcome to MotionMax",
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.55">
        <h1 style="font-size:22px;margin:0 0 12px">${greeting} 👋</h1>
        <p>Thanks for joining MotionMax. Your account is ready — head to your
        <a href="https://motionmax.io/app" style="color:#14C8CC;font-weight:600">dashboard</a>
        to create your first video.</p>
        <p style="margin-top:18px">A few things to try first:</p>
        <ul>
          <li>Pick a style and length, drop in a topic, and hit generate.</li>
          <li>Bring your own brand colors and voice for a consistent look.</li>
          <li>Schedule auto-posts so a steady stream of content goes out without daily effort (Creator plan).</li>
        </ul>
        <p style="margin-top:24px">Questions? Just reply to this email and our team will help you out.</p>
        <p style="color:#777;font-size:12px;margin-top:32px">— The MotionMax team</p>
      </div>
    `,
  });
}

export async function sendSupportEmail(to: string, subject: string, html: string, replyTo?: string): Promise<void> {
  await sendEmail({ to, subject, html, from: supportFromAddress(), replyTo });
}

export async function sendCancellationEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: "Your MotionMax subscription has been cancelled",
    html: `
      <h2>Subscription cancelled</h2>
      <p>Your subscription has been cancelled. You'll retain access until the end of your current billing period.</p>
      <p>Want to come back? <a href="https://motionmax.io/pricing">Resubscribe any time.</a></p>
    `,
  });
}
