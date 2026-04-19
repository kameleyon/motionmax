const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "MotionMax <noreply@motionmax.io>";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("[resend] RESEND_API_KEY not set — email skipped", { to: payload.to, subject: payload.subject });
    return;
  }

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, ...payload }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("[resend] Failed to send email", { status: res.status, body, to: payload.to });
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
