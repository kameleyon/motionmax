import { Helmet } from "react-helmet-async";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/dashboard/AppShell";
import { loadAdminFonts } from "@/lib/loadCaptionFonts";

// §5 PERF-002 fix (2026-05-10): support-tokens.css references Instrument
// Serif + JetBrains Mono. Both were removed from the public index.html
// font load. Idempotent inject when this page mounts.
loadAdminFonts();
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { invokeWithTrace, shortTraceRef } from "@/lib/tracing";

/** Support email — ground truth lives in HelpPopover.tsx and this
 *  must stay in sync with that one source. Used as the fallback
 *  mailto: target if the edge fn submission fails. */
const SUPPORT_EMAIL = "support@motionmax.io";

type Category = "all" | "started" | "billing" | "voice" | "render" | "account" | "api";

type Faq = {
  cat: Exclude<Category, "all">;
  q: string;
  a: React.ReactNode;
};

const FAQS: Faq[] = [
  {
    cat: "started",
    q: "How do I create my first MotionMax video?",
    a: (
      <>
        Click <code>+ New project</code> in the Studio sidebar. Pick a template or start blank, then drop in your script. MotionMax will suggest visuals, music and voice — review the storyboard, hit <code>Render</code>, and your video will be ready in 30–90 seconds depending on length.
      </>
    ),
  },
  {
    cat: "started",
    // B-NEW-21 (2026-05-10): copy aligned with new tier ladder. Free = 60 cr/mo + 100 daily.
    // Creator = 500 cr/mo (or 6,000/yr) at $29/mo after promo (or $14.50/mo billed annually).
    // Studio = 2,000 cr/mo (or 24,000/yr) at $129/mo after promo (or $64.50/mo billed annually).
    q: "What's the difference between Free, Creator and Studio?",
    a: (
      <>
        Free gives you 60 credits/month plus 100 daily refresh credits — full editor access, no card. Creator ($14.50/mo billed annually, or $29/mo after the intro period) unlocks 500 credits/month, 1 voice-clone slot, 1 automation slot, and watermark removal. Studio ($64.50/mo billed annually, or $129/mo after the intro period) raises that to 2,000 credits/month, 5 voice clones, 5 automation slots, priority queue, and watermark removal. See <a href="/pricing">Pricing</a> for the full comparison.
      </>
    ),
  },
  {
    cat: "billing",
    q: "How do credits work?",
    // B-NEW-21 (2026-05-10): credit math reflects new tier ladder. Subscription credits expire
    // on the 28th; daily refresh credits and top-up packs never expire (ToS §6).
    a: (
      <>
        Each generation consumes credits based on complexity and length. The Creator plan includes 500 credits/month (Studio includes 2,000) plus 200 daily refresh credits on top. Subscription credits expire on the 28th of each month and don't roll over. Daily refresh credits and top-up credit packs you buy on top of any plan never expire. Use the multi-pack ladder (1×–6×) on either paid plan if you want a larger monthly bucket without changing tier.
      </>
    ),
  },
  {
    cat: "billing",
    q: "Can I get a refund?",
    a: (
      <>
        We offer pro-rated refunds within 14 days of purchase if you've used less than 25% of your credits. Annual plans are refundable within 30 days. Contact support with your invoice number.
      </>
    ),
  },
  {
    cat: "billing",
    q: "Do you offer discounts for students or non-profits?",
    a: (
      <>
        Yes — 50% off Creator for verified students (.edu email) and 30% off any annual plan for registered non-profits and educators. Apply via the contact form below with proof of status.
      </>
    ),
  },
  {
    cat: "billing",
    // B-NEW-21 (2026-05-10): new FAQ entry covering the limited-time promo so support deflects.
    q: "What's the limited-time offer I see on the pricing page?",
    a: (
      <>
        New monthly subscriptions get up to 34% off for the first 3 months — Creator drops from $29/mo to $19/mo, Studio drops from $129/mo to $90/mo. After the third billing cycle, pricing returns to standard rates. Yearly plans bypass the promo entirely because they're already discounted up-front (Creator $174/yr, Studio $774/yr). The promo runs through July 15.
      </>
    ),
  },
  {
    cat: "billing",
    // B-NEW-21 (2026-05-10): new FAQ for top-up packs so users know they're available on Free too.
    q: "Can I buy credits without subscribing?",
    a: (
      <>
        Yes. Top-up credit packs are available to every tier — Free included. Pick from Quick (250 cr / $14.99), Plus (500 cr / $24.99), Power (1,000 cr / $44.99), Studio Pack (2,500 cr / $99.99), or Pro Pack (5,000 cr / $179.99). Top-up credits never expire. Open the "Buy more credits" modal from your dashboard's credit chip or from <a href="/pricing">Pricing</a>.
      </>
    ),
  },
  {
    cat: "voice",
    q: "How do I clone my voice?",
    a: (
      <>
        Open <code>Voice Lab</code>, click <code>+ Clone voice</code> and either upload 60+ seconds of clean audio (WAV/MP3) or record live in your browser. Training takes 2–4 minutes. Creator and Studio only (Free has no voice-clone slots). You must own the voice or have written consent — see our <a href="/acceptable-use">acceptable-use policy</a>.
      </>
    ),
  },
  {
    cat: "voice",
    q: "Can I use celebrity or copyrighted voices?",
    a: (
      <>
        No. Cloning anyone without their explicit, written consent violates our terms and most jurisdictions' likeness laws. Our system flags suspected impersonations automatically and we will suspend accounts. Stick to your own voice, hire actors, or use one of our licensed library voices.
      </>
    ),
  },
  {
    cat: "render",
    q: "Why did my render fail?",
    a: (
      <>
        Most failures are due to: (1) insufficient credits — top up via Billing; (2) source media exceeding 4 GB — compress with our built-in tool; (3) network drops during upload — try again. If the same project fails twice, contact support with the project ID and we'll inspect the queue logs.
      </>
    ),
  },
  {
    cat: "render",
    q: "What output formats do you support?",
    a: (
      <>
        MP4 (H.264, H.265/HEVC), MOV (ProRes 422 on Studio), WebM (VP9), and animated WebP. Aspect ratios: 16:9, 9:16, 1:1, 4:5 and 21:9. Audio always exports as 48 kHz stereo AAC; you can also pull a stem-separated WAV bundle on Studio.
      </>
    ),
  },
  {
    cat: "render",
    q: "How long do my renders stay in the cloud?",
    a: (
      <>
        Free: 14 days. Creator: 90 days. Studio: indefinitely (subject to fair-use limits of 500 GB). After expiry, project source files remain — only the rendered MP4 is purged. Re-rendering is free if you have credits.
      </>
    ),
  },
  {
    cat: "account",
    q: "How do I invite teammates?",
    a: (
      <>
        Team workspaces aren't available yet — every plan today is a single-seat account. When Studio gains team support it will include 5 seats with additional seats at $19/month each. Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if you'd like an early-access invite.
      </>
    ),
  },
  {
    cat: "account",
    q: "Can I delete my account?",
    a: (
      <>
        Yes, anytime, from <a href="/settings">Settings → Profile → Danger zone</a>. Your data is queued for deletion and permanently removed within 7 days. Active subscriptions are pro-rated and refunded automatically. Export your projects first if you want to keep them.
      </>
    ),
  },
  {
    cat: "api",
    q: "Where can I find API documentation?",
    a: (
      <>
        MotionMax doesn't have a public API yet — everything today runs through the web app and the Supabase-backed dashboard. We're prioritising programmatic access keys, webhooks and a REST SDK on the next quarterly roadmap. Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your use-case to get on the early-access list.
      </>
    ),
  },
  {
    cat: "api",
    q: "Are there rate limits?",
    a: (
      <>
        There are no public-API rate limits because there's no public API yet. When it ships, Studio plans will have 100 requests/minute and 10,000/day with a <code>429</code> + <code>Retry-After</code> header response on exceedance. Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> about Enterprise limits.
      </>
    ),
  },
];

const CATS: { id: Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "started", label: "Getting started" },
  { id: "billing", label: "Billing & credits" },
  { id: "voice", label: "Voices" },
  { id: "render", label: "Rendering" },
  { id: "account", label: "Account" },
  { id: "api", label: "API" },
];

/** Topic IDs for the contact form. These must match the
 *  `support_tickets.topic` CHECK constraint in the migration:
 *  ('billing','render','voice','account','api','other'). */
type ContactTopic = "billing" | "render" | "voice" | "account" | "api" | "other";

const TOPICS: { id: ContactTopic; label: string }[] = [
  { id: "other", label: "General question" },
  { id: "billing", label: "Billing & refunds" },
  { id: "render", label: "Rendering / bug report" },
  { id: "voice", label: "Voice cloning support" },
  { id: "account", label: "Account / login" },
  { id: "api", label: "API / integrations" },
];

/* ── System status types & query ────────────────────────────────────── */

type StatusKind = "operational" | "degraded" | "down";
interface StatusBucket { status: StatusKind; detail: string }
interface SystemStatusPayload {
  render_queue: StatusBucket;
  voice_synthesis: StatusBucket;
  media_pipeline: StatusBucket;
  api_webhooks: StatusBucket;
}

async function fetchSystemStatus(): Promise<SystemStatusPayload> {
  const { data, error } = await supabase.rpc("support_system_status" as never);
  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as SystemStatusPayload;
}

function useSystemStatus() {
  return useQuery({
    queryKey: ["help", "system-status"],
    queryFn: fetchSystemStatus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/* ── Env-driven external links — community + scheduling ─────────────── */


/* ── Status row — aqua dot for operational, gold for degraded, gold-bordered em-dash for down ── */

function StatusRow({ label, bucket, last }: { label: string; bucket: StatusBucket | undefined; last?: boolean }) {
  const status = bucket?.status ?? "operational";
  const detail = bucket?.detail ?? "—";
  const dotStyle: React.CSSProperties =
    status === "operational"
      ? { background: "#14C8CC", boxShadow: "0 0 8px rgba(20,200,204,.7)" }
      : status === "degraded"
        ? { background: "#E4C875", boxShadow: "0 0 8px rgba(228,200,117,.7)" }
        : { background: "transparent", border: "1px solid #E4C875", boxShadow: "0 0 6px rgba(228,200,117,.5)" };
  return (
    <div className="status-row" style={last ? { marginBottom: 0 } : undefined}>
      <span className="status-dot" aria-hidden="true" style={dotStyle} />
      <span className="t">{label}</span>
      <span className="v" title={detail} style={{ textTransform: "uppercase" }}>
        {status === "down" ? "—" : detail}
      </span>
    </div>
  );
}

export default function Help() {
  const { user } = useAuth();

  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<Category>("all");
  // Track open FAQ items by stable index. The first one defaults open
  // to mirror the design HTML's `first` open behaviour.
  const [openFaq, setOpenFaq] = useState<Set<number>>(new Set([0]));

  // Contact form
  const [name, setName] = useState("");
  const [email, setEmail] = useState(user?.email ?? "");
  const [topic, setTopic] = useState<ContactTopic>("other");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [attachLogs, setAttachLogs] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSentDialog, setShowSentDialog] = useState(false);
  const [sentTicketId, setSentTicketId] = useState<string | null>(null);

  // Live system status — refreshed every 60s while the page is open.
  const status = useSystemStatus();

  // Filter FAQs by category + search query
  const visibleFaqs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return FAQS.map((f, idx) => ({ ...f, idx })).filter((f) => {
      if (activeCat !== "all" && f.cat !== activeCat) return false;
      if (!q) return true;
      const text = (f.q + " " + (typeof f.a === "string" ? f.a : "")).toLowerCase();
      return text.includes(q);
    });
  }, [search, activeCat]);

  function toggleFaq(idx: number) {
    setOpenFaq((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  // Mailto fallback for when the edge fn fails — keeps the user
  // unblocked even if the ticket backend is down.
  function openMailtoFallback(): void {
    const topicLabel = TOPICS.find((t) => t.id === topic)?.label ?? topic;
    const bodyText =
      `From: ${name} <${email}>\n` +
      `Topic: ${topicLabel}\n` +
      (attachLogs ? `Attach diagnostic logs: yes\n` : "") +
      `\n${description}\n`;
    const url =
      `mailto:${SUPPORT_EMAIL}` +
      `?subject=${encodeURIComponent(`[${topicLabel}] ${subject}`)}` +
      `&body=${encodeURIComponent(bodyText)}`;
    window.location.href = url;
  }

  /** Submit via the `submit-support-ticket` edge fn. On failure
   *  (network, auth, rate-limit, validation), we degrade to a
   *  pre-filled mailto: so the user is never stranded. */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !subject.trim() || !description.trim()) return;
    setIsSubmitting(true);
    try {
      // Audit C-9-6: trace-propagated invoke. Support tickets are exactly
      // where trace IDs matter most — when this submission fails, the user
      // gets the Ref string back as part of the mailto: fallback so the
      // engineer who picks up the email can search Sentry directly.
      const { data, error, traceId } = await invokeWithTrace<{ ok?: boolean; id?: string; error?: string }>(
        "submit-support-ticket",
        {
          body: {
            name: name.trim(),
            email: email.trim(),
            subject: subject.trim(),
            body: description.trim(),
            topic,
          },
        },
      );
      if (error || !data?.ok || !data.id) {
        const errMsg = error instanceof Error ? error.message : undefined;
        const message = (data?.error as string | undefined) ?? errMsg ?? "Couldn't reach the ticket service.";
        throw new Error(`${message} (Ref: ${shortTraceRef(traceId)})`);
      }
      setSentTicketId(data.id);
      const short = data.id.slice(0, 6);
      toast.success(`Ticket #${short}… submitted — we'll reply within one business day.`);
      setShowSentDialog(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      toast.error(`${message}. Opening your email client as a fallback.`);
      openMailtoFallback();
    } finally {
      setIsSubmitting(false);
    }
  }

  const totalArticles = FAQS.length;

  return (
    <AppShell breadcrumb="Help & support">
      <Helmet>
        <title>Help &amp; Support · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="support-shell">
        <div className="sup-wrap">
          {/* ─── Hero ──────────────────────────────────────────── */}
          <div className="help-hero">
            <h2>How can we <em>help</em>?</h2>
            <p className="sub">
              Search the knowledge base, browse common questions, or reach out — our team replies within one business day on weekdays.
            </p>

            <label className="help-search" htmlFor="sup-search">
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5A6268" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                id="sup-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search articles, e.g. 'voice cloning' or 'render failed'…"
                aria-label="Search help articles"
              />
              <kbd>↵</kbd>
            </label>

            <div className="qg">
              <a className="q-card" href="#getting-started" onClick={() => setActiveCat("started")}>
                <div className="ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <path d="M5 3v18l7-5 7 5V3z" />
                  </svg>
                </div>
                <div className="t">Getting started</div>
                <div className="d">First project, basics &amp; UI tour</div>
              </a>
              <a className="q-card" href="#getting-started" onClick={() => setActiveCat("billing")}>
                <div className="ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <rect x="2" y="6" width="20" height="13" rx="2" />
                    <path d="M2 10h20M6 15h4" />
                  </svg>
                </div>
                <div className="t">Billing &amp; credits</div>
                <div className="d">Plans, invoices &amp; refunds</div>
              </a>
              <a className="q-card" href="#getting-started" onClick={() => setActiveCat("voice")}>
                <div className="ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />
                  </svg>
                </div>
                <div className="t">Voices &amp; cloning</div>
                <div className="d">Voice Lab, training, ethics</div>
              </a>
              <a className="q-card" href="#contact">
                <div className="ico">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div className="t">Contact us</div>
                <div className="d">Tickets · 1 business day reply</div>
              </a>
            </div>
          </div>

          {/* ─── Contact ───────────────────────────────────────── */}
          <div className="faq-section" id="contact" style={{ marginTop: 32 }}>
            <div className="head">
              <h3>Still need help?</h3>
            </div>
            <div className="contact-grid">
              {/* Posts to the `submit-support-ticket` edge fn. Falls
                  back to mailto: if the API call fails. */}
              <form className="card" onSubmit={handleSubmit}>
                <h3>Send us a message</h3>
                <div className="reply-lede">
                  Replies typically arrive within <b>one business day</b>.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div className="grid-2">
                    <div className="fld">
                      <label htmlFor="sup-name">Your name</label>
                      <input
                        id="sup-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Your name"
                        required
                      />
                    </div>
                    <div className="fld">
                      <label htmlFor="sup-email">Email</label>
                      <input
                        id="sup-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        required
                      />
                    </div>
                  </div>
                  <div className="fld">
                    <label htmlFor="sup-topic">Topic</label>
                    <select
                      id="sup-topic"
                      value={topic}
                      onChange={(e) => setTopic(e.target.value as ContactTopic)}
                    >
                      {TOPICS.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="fld">
                    <label htmlFor="sup-subject">Subject</label>
                    <input
                      id="sup-subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="One-line summary of your issue"
                      required
                    />
                  </div>
                  <div className="fld">
                    <label htmlFor="sup-desc">Description</label>
                    <textarea
                      id="sup-desc"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Include steps to reproduce, project IDs, screenshots if helpful…"
                      required
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--ink-dim)", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={attachLogs}
                        onChange={(e) => setAttachLogs(e.target.checked)}
                        style={{ accentColor: "#14C8CC" }}
                      />
                      Attach diagnostic logs
                    </label>
                    <button type="submit" className="btn-cyan" disabled={isSubmitting}>
                      {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : null}
                      Send message
                    </button>
                  </div>
                </div>
              </form>

              <div>
                <div className="card" style={{ marginBottom: 14 }}>
                  <h3>Other ways to reach us</h3>
                  {/* Audit cleanup — removed the "Live chat · Coming soon"
                      placeholder row. Vaporware in the support UI erodes
                      trust ("if even Help has placeholders, what else is
                      half-built?"). The mailto: row below is the real,
                      monitored channel — promoted to primary. */}
                  <a
                    className="touch-row"
                    href={`mailto:${SUPPORT_EMAIL}?subject=MotionMax%20support`}
                    style={{ marginBottom: 0 }}
                  >
                    <div className="ico">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="M22 7l-10 6L2 7" />
                      </svg>
                    </div>
                    <div className="meta">
                      <div className="t">{SUPPORT_EMAIL}</div>
                      <div className="d">Account, billing &amp; everything else — one business day reply</div>
                    </div>
                    <svg className="arr" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </a>
                </div>

                {/* ─── System status ─────────────────────────────────
                    Live: derived from video_generation_jobs /
                    system_logs / generations via the
                    `support_system_status` RPC. Lives under "Other
                    ways to reach us" in the right column so the
                    contact form claims the wider 1.4fr slot — the
                    contact-grid collapses to a single column below
                    900 px (already in support-tokens.css), so on
                    mobile the status card just stacks under the
                    reach-us card without extra rules. */}
                <div className="card">
                  <div className="h-row">
                    <h3>System status</h3>
                    <span
                      className="soon-tag"
                      style={{
                        color: "#14C8CC",
                        background: "rgba(20,200,204,.12)",
                        borderColor: "rgba(20,200,204,.28)",
                      }}
                    >
                      LIVE
                    </span>
                  </div>
                  <StatusRow label="Render queue" bucket={status.data?.render_queue} />
                  <StatusRow label="Voice synthesis" bucket={status.data?.voice_synthesis} />
                  <StatusRow label="Media pipeline" bucket={status.data?.media_pipeline} />
                  <StatusRow label="API & webhooks" bucket={status.data?.api_webhooks} last />
                </div>
              </div>
            </div>
          </div>

          {/* ─── FAQ ───────────────────────────────────────────── */}
          <div className="faq-section" id="getting-started">
            <div className="head">
              <h3>Frequently asked</h3>
              <span className="count">{totalArticles} articles</span>
            </div>

            <div className="cat-tabs" role="tablist" aria-label="FAQ categories">
              {CATS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={activeCat === c.id}
                  className={activeCat === c.id ? "on" : ""}
                  onClick={() => setActiveCat(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="faq">
              {visibleFaqs.length === 0 ? (
                <div style={{ padding: 24, fontSize: 13, color: "var(--ink-mute)", textAlign: "center" }}>
                  No articles match your search. Try a different keyword or {" "}
                  <a href="#contact" style={{ color: "var(--cyan)" }}>contact us directly</a>.
                </div>
              ) : (
                visibleFaqs.map((f) => {
                  const open = openFaq.has(f.idx);
                  return (
                    <div key={f.idx} className={open ? "faq-item open" : "faq-item"}>
                      <button
                        type="button"
                        className="faq-q"
                        onClick={() => toggleFaq(f.idx)}
                        aria-expanded={open}
                      >
                        <span>{f.q}</span>
                        <svg
                          aria-hidden="true"
                          className="chev"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <div className="faq-a">
                        <div className="faq-a-inner">{f.a}</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Submission confirmation. Replaces the previous mailto-only
          dialog with a real ticket-id receipt. */}
      <AlertDialog open={showSentDialog} onOpenChange={setShowSentDialog}>
        <AlertDialogContent className="support-modal-content">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: 20, letterSpacing: "-0.01em", color: "#ECEAE4" }}>
              Ticket submitted
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, color: "#8A9198", fontSize: 13.5, lineHeight: 1.55 }}>
                <p style={{ margin: 0 }}>
                  Thanks — we received your message{sentTicketId ? <> as ticket{" "}
                    <strong style={{ color: "#ECEAE4", fontFamily: "var(--mono)" }}>#{sentTicketId.slice(0, 6)}…</strong></> : ""}.
                  We'll reply to{" "}
                  <strong style={{ color: "#ECEAE4" }}>{email || "your email"}</strong> within one business day.
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "#5A6268" }}>
                  Need to add more context? Just reply to our email when it arrives.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5">
              Close
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowSentDialog(false);
                setSentTicketId(null);
                setName("");
                setSubject("");
                setDescription("");
                setAttachLogs(false);
              }}
              className="bg-[#14C8CC] text-[#06181a] hover:bg-[#0FA6AE]"
            >
              Got it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
