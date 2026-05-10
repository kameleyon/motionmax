// Lifecycle email template renderer (B-NEW-8 Herald lifecycle gap fix).
//
// Why bespoke instead of a template engine:
//   • Deno cold-start cost matters — Resend dispatch is on the hot path
//     for signup, so we keep template handling to plain string ops and
//     a single Deno.readTextFile per send.
//   • Templates are static HTML with `{{var}}` slots; no loops, no
//     conditionals. A 25-line replace function covers the surface area.
//   • Same shape as the inline emailTemplate.ts — designers tweak HTML
//     without touching TypeScript.
//
// Usage:
//   const { subject, html, text } = await renderTemplate("day_1", {
//     user_email: "alice@example.com",
//     unsubscribe_url: "https://motionmax.io/unsubscribe?t=…",
//     greeting: "Hi Alice,",
//   });
//
// All non-receipt drip templates share the same _layout.html wrapper.
// Each drip's HTML file contains ONLY the body section (with slots);
// the helper wraps it in the layout, fills in subject/preheader/CTA
// from TEMPLATE_META, and runs the substitution pass.

import { LEGAL_VERSIONS } from "./legal-versions.ts";

/** Per-template metadata: subject line, preheader, CTA copy, CTA href. */
export interface TemplateMeta {
  subject: string;
  preheader: string;
  headline: string;
  /** CTA label rendered in the gold button. Empty = no CTA row. */
  cta_label: string;
  /** CTA href; supports {{var}} substitution against the supplied vars. */
  cta_href: string;
}

export const TEMPLATE_META: Record<string, TemplateMeta> = {
  // ── Day-0 (welcome) — kept here for completeness; the existing
  //    notify-signup-welcome edge fn renders this inline today.
  //
  // Wave C Herald rewrite — first-touch is about ONE action (ship a
  // video), not a feature tour. Paid-plan language was scrubbed: free
  // users were getting "Creator plan benefits" copy on day 0, which
  // tested as confusing (people thought they'd been charged). Subject
  // personalises with {{first_name}} via the standard template var
  // pipeline — the substituter renders an empty string when the var is
  // missing, so the welcome handler in notify-signup-welcome must pass
  // first_name explicitly or fall back to "there" at call time.
  welcome: {
    subject: "{{first_name}}, your first video is 3 minutes away",
    preheader: "One topic, one style, one render. We'll walk you through the rest after.",
    headline: "Let's ship your first video",
    cta_label: "Start my first video",
    cta_href: "https://motionmax.io/create",
  },
  // ── Payment-failed (Stripe invoice.payment_failed) ──────────────────
  // Wave C Herald rewrite. Original copy ("Payment failed") tested as
  // panic-inducing: half of recipients assumed they were locked out
  // immediately. New copy leads with what happened ("didn't go
  // through"), what they need to do ("update card"), and reassures on
  // the grace period so they don't churn out of fear.
  payment_failed: {
    subject: "Action needed: card declined on your motionmax subscription",
    preheader: "Update your card to keep your subscription active — we'll retry automatically.",
    headline: "Your last payment didn't go through",
    cta_label: "Update payment method",
    cta_href: "https://motionmax.io/settings/billing",
  },
  // ── Cancellation-confirmed ──────────────────────────────────────────
  // Wave C Herald rewrite. Added two retention hooks per the Wave-C
  // brief: a 30-sec exit survey link (placeholder URL — wire to a real
  // form when one exists) and a "you can come back" line referencing
  // the 30-day project-retention window. We DO NOT mention the
  // CancelRetentionModal's 50%-off coupon in this email — the coupon
  // is meant to fire BEFORE cancel-click, not after.
  cancellation_confirmed: {
    subject: "Your motionmax subscription is cancelled",
    preheader: "You'll keep access until the end of your billing period. Your projects stay for 30 days.",
    headline: "Sorry to see you go",
    cta_label: "Take the 30-second survey",
    cta_href: "https://motionmax.io/feedback?source=cancel_email",
  },
  // ── Day-1 — first-project nudge.
  day_1: {
    subject: "Your first project takes 90 seconds",
    preheader: "A quick primer on how MotionMax works — and how to ship a video today.",
    headline: "Your first project takes 90 seconds",
    cta_label: "Create my first video",
    cta_href: "https://motionmax.io/create",
  },
  // ── Day-3 — feature spotlight: how creators use MotionMax.
  day_3: {
    subject: "How creators are using MotionMax",
    preheader: "Cinematic generation, brand kits, and ready-to-share clips.",
    headline: "How creators are using MotionMax",
    cta_label: "See examples",
    cta_href: "https://motionmax.io/showcase",
  },
  // ── Day-7 — soft upgrade prompt.
  day_7: {
    subject: "Ready to make your second video?",
    preheader: "A few things you can unlock with the Creator plan.",
    headline: "Ready for your next one?",
    cta_label: "Make another video",
    cta_href: "https://motionmax.io/create",
  },
  // ── Day-14 — feedback request, last automated touchpoint.
  day_14: {
    subject: "We'd love your feedback",
    preheader: "Tell us what's working — and what isn't.",
    headline: "How's MotionMax going for you?",
    cta_label: "Share feedback",
    cta_href: "https://motionmax.io/feedback",
  },
  // ── Win-back at 30 days dormant.
  winback_30: {
    subject: "We've added something you'll like",
    preheader: "New in MotionMax — and your projects are still here.",
    headline: "We've been busy",
    cta_label: "See what's new",
    cta_href: "https://motionmax.io/app",
  },
  // ── Win-back at 60 days dormant — emotional re-engagement.
  winback_60: {
    subject: "Coming back? Here's a credit",
    preheader: "Your account is still here — and so is the credit on us.",
    headline: "We saved your seat",
    cta_label: "Pick up where I left off",
    cta_href: "https://motionmax.io/app",
  },
  // ── Branded purchase receipt (replaces / supplements Stripe default).
  receipt: {
    subject: "Your MotionMax receipt",
    preheader: "Thanks for upgrading. Here are the details.",
    headline: "Thanks for upgrading",
    cta_label: "View invoice",
    cta_href: "{{invoice_url}}",
  },
};

/** Cached layout — read once per Deno isolate. */
let _layoutCache: string | null = null;
async function loadLayout(): Promise<string> {
  if (_layoutCache !== null) return _layoutCache;
  const layoutUrl = new URL("./_layout.html", import.meta.url);
  _layoutCache = await Deno.readTextFile(layoutUrl);
  return _layoutCache;
}

/** Per-template body cache. */
const _bodyCache = new Map<string, string>();
async function loadBody(name: string): Promise<string> {
  const cached = _bodyCache.get(name);
  if (cached !== undefined) return cached;
  const url = new URL(`./${name}.html`, import.meta.url);
  const body = await Deno.readTextFile(url);
  _bodyCache.set(name, body);
  return body;
}

/** Strip HTML tags for a plaintext fallback. Crude but fine for Resend's
 *  `text` field — better than nothing, and Gmail's plaintext renderer
 *  handles loose HTML reasonably anyway. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Replace `{{key}}` markers with `vars[key]`. Missing or undefined
 *  values become "" so unfilled slots don't render as the literal
 *  `{{var}}` to the recipient. */
function substitute(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderVars {
  /** REQUIRED — used in the footer for "you're receiving this at …". */
  user_email: string;
  /** REQUIRED for CAN-SPAM — unique unsubscribe link for the recipient. */
  unsubscribe_url: string;
  /** Optional personalised greeting line; defaults to "Hi there,". */
  greeting?: string;
  /** Optional first-name; used by the welcome subject. Falls back to
   *  the literal "there" when omitted or empty so the subject stays
   *  grammatical. */
  first_name?: string;
  /** Receipt-specific: link to the Stripe-hosted invoice PDF. */
  invoice_url?: string;
  /** Receipt-specific: plan/pack name purchased. */
  plan?: string;
  /** Receipt-specific: HTML rows for the line-items table. */
  line_items_html?: string;
  /** Receipt-specific: human-readable amount paid (with currency). */
  total?: string;
  /** Receipt-specific: human-readable billing period. */
  period?: string;
  /** Win-back 30: latest shipped feature blurb. Generic if omitted. */
  recent_feature?: string;
  /** Allow ad-hoc extras for templates that need extra slots. */
  [key: string]: string | undefined;
}

/**
 * Render a lifecycle template by name.
 *
 * @param name  one of TEMPLATE_META keys
 * @param vars  substitution map; user_email + unsubscribe_url required.
 * @returns     { subject, html, text } ready for Resend.
 */
export async function renderTemplate(
  name: keyof typeof TEMPLATE_META,
  vars: RenderVars,
): Promise<RenderedEmail> {
  const meta = TEMPLATE_META[name];
  if (!meta) throw new Error(`renderTemplate: unknown template "${name}"`);

  const layout = await loadLayout();
  const body = await loadBody(name);

  const greeting = vars.greeting ?? "Hi there,";

  // Wave C Herald — the welcome subject personalises with {{first_name}}.
  // We default to "there" so the line reads "there, your first video is
  // 3 minutes away" instead of the literal ", your first video is …" when
  // the caller didn't pass a name. Same default flows into all other
  // templates that may opt into first_name in future without code change.
  const varsWithDefaults: Record<string, string | undefined> = {
    ...(vars as Record<string, string | undefined>),
    greeting,
    first_name: (vars.first_name && vars.first_name.trim().length > 0)
      ? vars.first_name.trim()
      : "there",
  };

  // Subject is META-defined but may itself contain {{var}} (welcome:
  // first_name). Substitute against the same vars-with-defaults so both
  // the rendered HTML and the returned `subject` are consistent.
  const filledSubject = substitute(meta.subject, varsWithDefaults);

  // Two-pass substitution: body first (so its filled-in vars can flow
  // through into the layout's {{body_html}} slot), then layout.
  const filledBody = substitute(body, varsWithDefaults);

  const filledLayout = substitute(layout, {
    ...varsWithDefaults,
    subject: filledSubject,
    preheader: meta.preheader,
    headline: meta.headline,
    cta_label: meta.cta_label,
    cta_href: substitute(meta.cta_href, varsWithDefaults),
    body_html: filledBody,
    tos_version: LEGAL_VERSIONS.tos,
  });

  return {
    subject: filledSubject,
    html: filledLayout,
    text: htmlToText(filledLayout),
  };
}

/** Test-only — clear the file cache so unit tests can re-read templates
 *  after editing them on disk. Production callers never need this. */
export function __clearTemplateCacheForTests(): void {
  _layoutCache = null;
  _bodyCache.clear();
}
