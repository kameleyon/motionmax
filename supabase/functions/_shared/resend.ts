import { buildEmail } from "./emailTemplate.ts";

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

const greetingFor = (name?: string): string =>
  name?.trim() ? `Hi ${name.trim()},` : "Hi there,";

// ── Welcome on subscription activation (Stripe webhook) ───────────────
export async function sendWelcomeEmail(to: string, planName: string, displayName?: string): Promise<void> {
  const html = buildEmail({
    preheader: `Your ${planName} plan is active — start creating.`,
    greeting: greetingFor(displayName),
    headline: "You're all set",
    bodyHtml: `
      <p>Your <strong style="color:#E4C875;">${planName}</strong> plan is now active. Head to your dashboard to start creating.</p>
      <p>Need a hand? Just reply to this email — we read every message.</p>
    `,
    cta: { label: "Open dashboard", href: "https://motionmax.io/app" },
  });
  await sendEmail({ to, subject: `Welcome to MotionMax — ${planName} plan active`, html });
}

// ── Generic signup welcome (free + paid) ──────────────────────────────
export async function sendSignupWelcomeEmail(to: string, displayName?: string): Promise<void> {
  const html = buildEmail({
    preheader: "Your MotionMax account is ready — start creating.",
    greeting: greetingFor(displayName),
    headline: "Welcome to MotionMax",
    bodyHtml: `
      <p>Thanks for joining. Your account is ready — head to the dashboard to create your first video.</p>
      <p style="margin-top:18px;">A few things to try first:</p>
      <ul style="padding-left:20px;margin:8px 0 0 0;color:#C8CCCE;">
        <li style="margin-bottom:6px;">Pick a style and length, drop in a topic, hit generate.</li>
        <li style="margin-bottom:6px;">Bring your own brand colors and voice for a consistent look.</li>
        <li style="margin-bottom:6px;">Schedule auto-posts so a steady stream of content goes out without daily effort <span style="color:#E4C875;">(Creator plan)</span>.</li>
      </ul>
    `,
    cta: { label: "Open dashboard", href: "https://motionmax.io/app" },
  });
  await sendEmail({ to, subject: "Welcome to MotionMax", html });
}

// ── Payment failed ────────────────────────────────────────────────────
export async function sendPaymentFailedEmail(to: string, displayName?: string): Promise<void> {
  const html = buildEmail({
    preheader: "Action required: update your payment method.",
    greeting: greetingFor(displayName),
    headline: "Payment failed",
    bodyHtml: `
      <p>We couldn't process your most recent payment. Update your payment method to keep your subscription active —
      your account stays accessible during a short grace period.</p>
    `,
    cta: { label: "Update payment", href: "https://motionmax.io/settings/billing" },
  });
  await sendEmail({ to, subject: "Action required: payment failed", html });
}

// ── Cancellation ──────────────────────────────────────────────────────
export async function sendCancellationEmail(to: string, displayName?: string): Promise<void> {
  const html = buildEmail({
    preheader: "Your subscription has been cancelled.",
    greeting: greetingFor(displayName),
    headline: "Subscription cancelled",
    bodyHtml: `
      <p>Your subscription has been cancelled. You'll keep access until the end of your current billing period.</p>
      <p>Want to come back? You can resubscribe any time.</p>
    `,
    cta: { label: "View pricing", href: "https://motionmax.io/pricing" },
  });
  await sendEmail({ to, subject: "Your MotionMax subscription has been cancelled", html });
}

// ── Branded purchase receipt (B-NEW-8) ────────────────────────────────
// Replaces the unbranded Stripe default. Caller passes pre-rendered
// line-items HTML so this fn stays presentation-only — webhook handler
// owns the Stripe → HTML mapping.
//
// CAN-SPAM note: receipts are transactional, so unsubscribe is NOT
// strictly required, but we include it anyway because the layout
// shipped via the lifecycle template helper builds it in. The user
// invoking this helper supplies the unsubscribe URL via the template
// var pipeline (see _shared/email-templates/_helper.ts).
export interface BrandedReceiptArgs {
  to: string;
  displayName?: string;
  plan: string;
  /** Pre-rendered <tr> rows for the line-items table. */
  lineItemsHtml: string;
  /** Human-readable total, e.g. "$29.00 USD". */
  total: string;
  /** Human-readable billing period, e.g. "May 10 – Jun 10, 2026". */
  period: string;
  /** Stripe invoice hosted-PDF URL (or hosted_invoice_url). */
  invoiceUrl: string;
  /** Recipient unsubscribe link (built from profiles.unsubscribe_token). */
  unsubscribeUrl: string;
}
export async function sendBrandedReceiptEmail(args: BrandedReceiptArgs): Promise<void> {
  // Lazy import to avoid loading the template runtime in functions that
  // don't need it (cold-start cost matters for short-lived edge fns).
  const { renderTemplate } = await import("./email-templates/_helper.ts");
  const rendered = await renderTemplate("receipt", {
    user_email: args.to,
    unsubscribe_url: args.unsubscribeUrl,
    greeting: args.displayName?.trim() ? `Hi ${args.displayName.trim()},` : "Hi there,",
    plan: args.plan,
    line_items_html: args.lineItemsHtml,
    total: args.total,
    period: args.period,
    invoice_url: args.invoiceUrl,
  });
  await sendEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
  });
}

// ── Generic support email — used by admin Communicate panel ──────────
export async function sendSupportEmail(
  to: string,
  subject: string,
  bodyHtml: string,
  opts?: { displayName?: string; replyTo?: string; preheader?: string },
): Promise<void> {
  const html = buildEmail({
    preheader: opts?.preheader ?? subject,
    greeting: greetingFor(opts?.displayName),
    headline: subject,
    bodyHtml,
    footerNote: "Replying to this email reaches MotionMax support.",
  });
  await sendEmail({
    to,
    subject,
    html,
    from: supportFromAddress(),
    replyTo: opts?.replyTo,
  });
}
