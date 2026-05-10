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
// Wave C Herald rewrite. Now routes through the lifecycle template
// helper so the day-0 email matches the rest of the drip series in
// brand, layout, and copy voice — and so a designer change to
// welcome.html flows through to BOTH the drip cron AND the
// notify-signup-welcome path with one edit.
//
// The old inline copy mentioned "Creator plan benefits" / "Schedule
// auto-posts (Creator plan)" to free users on day 0 — Wave 5 noted
// that as confusing (people thought they'd been billed). New copy is
// single-CTA, single-goal: ship one video, the rest of the tour
// arrives on day 1. See welcome.html for the rendered body.
export async function sendSignupWelcomeEmail(to: string, displayName?: string): Promise<void> {
  const { renderTemplate } = await import("./email-templates/_helper.ts");
  const rendered = await renderTemplate("welcome", {
    user_email: to,
    // Welcome is technically transactional, but the layout always
    // renders an unsubscribe link for consistency. /unsubscribe is the
    // generic landing page when we don't have a per-recipient token.
    unsubscribe_url: "https://motionmax.io/unsubscribe",
    greeting: greetingFor(displayName),
    first_name: displayName,
  });
  await sendEmail({ to, subject: rendered.subject, html: rendered.html });
}

// ── Payment failed ────────────────────────────────────────────────────
// Wave C Herald rewrite. Routes through the lifecycle template helper
// so the copy (subject + body + CTA) lives in the same place as the
// drip series — designers can iterate without touching TypeScript.
// `unsubscribeUrl` falls back to the generic /unsubscribe page when the
// caller didn't pass a per-user token (transactional emails don't
// strictly need an unsubscribe under CAN-SPAM, but the shared layout
// renders the link unconditionally for consistency).
export async function sendPaymentFailedEmail(
  to: string,
  displayName?: string,
  unsubscribeUrl: string = "https://motionmax.io/unsubscribe",
): Promise<void> {
  const { renderTemplate } = await import("./email-templates/_helper.ts");
  const rendered = await renderTemplate("payment_failed", {
    user_email: to,
    unsubscribe_url: unsubscribeUrl,
    greeting: greetingFor(displayName),
    first_name: displayName,
  });
  await sendEmail({ to, subject: rendered.subject, html: rendered.html });
}

// ── Cancellation ──────────────────────────────────────────────────────
// Wave C Herald rewrite. Same template-helper route as payment_failed.
// `periodEnd` shows the user when their paid access actually ends so
// they can plan a possible resubscribe inside the 30-day project-retention
// window (see cancellation_confirmed.html body copy). Falls back to a
// generic "the end of your billing period" when the caller didn't pass
// the date.
export async function sendCancellationEmail(
  to: string,
  displayName?: string,
  periodEnd?: string,
  unsubscribeUrl: string = "https://motionmax.io/unsubscribe",
): Promise<void> {
  const { renderTemplate } = await import("./email-templates/_helper.ts");
  const rendered = await renderTemplate("cancellation_confirmed", {
    user_email: to,
    unsubscribe_url: unsubscribeUrl,
    greeting: greetingFor(displayName),
    first_name: displayName,
    period_end: periodEnd && periodEnd.trim().length > 0
      ? periodEnd
      : "the end of your billing period",
  });
  await sendEmail({ to, subject: rendered.subject, html: rendered.html });
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
  /** Wave C Herald — optional trace_id (Stripe event id) rendered in
   *  the receipt footer so a user reporting a billing issue can quote
   *  it back to support, who can then pull the exact webhook trace in
   *  Sentry. Omit when the caller doesn't have one. */
  traceId?: string;
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
    trace_id: args.traceId,
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
