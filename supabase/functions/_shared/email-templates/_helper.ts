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
  welcome: {
    subject: "Welcome to MotionMax",
    preheader: "Your account is ready — start creating.",
    headline: "Welcome to MotionMax",
    cta_label: "Open dashboard",
    cta_href: "https://motionmax.io/app",
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

  // Two-pass substitution: body first (so its filled-in vars can flow
  // through into the layout's {{body_html}} slot), then layout.
  const filledBody = substitute(body, {
    ...(vars as Record<string, string | undefined>),
    greeting,
  });

  const filledLayout = substitute(layout, {
    ...(vars as Record<string, string | undefined>),
    greeting,
    subject: meta.subject,
    preheader: meta.preheader,
    headline: meta.headline,
    cta_label: meta.cta_label,
    cta_href: substitute(meta.cta_href, vars as Record<string, string | undefined>),
    body_html: filledBody,
    tos_version: LEGAL_VERSIONS.tos,
  });

  return {
    subject: meta.subject,
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
