import { Helmet } from "react-helmet-async";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import AppShell from "@/components/dashboard/AppShell";
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

/** Support email — ground truth lives in HelpPopover.tsx and this
 *  must stay in sync with that one source. Email-based for now: until a
 *  ticket backend ships, "Send message" composes a `mailto:` from the
 *  filled form so the team still gets the report in their inbox. */
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
    q: "What's the difference between Studio, Pro and Free plans?",
    a: (
      <>
        Free includes 1,000 credits/month and watermarked output. Pro ($29/mo) unlocks 50,000 credits, HD exports and voice cloning. Studio ($99/mo) adds 4K, priority queue, 5 team seats, brand kits and removed branding. See <a href="/billing">Billing</a> for the full comparison.
      </>
    ),
  },
  {
    cat: "billing",
    q: "How do credits work?",
    a: (
      <>
        Each second of finished 1080p video costs roughly 8 credits; 4K costs 24. Voice generation is 1 credit per word. Credits reset on the 1st of each month. Unused credits don't roll over on Pro; Studio members keep up to 10,000 in reserve.
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
        Yes — 50% off Pro for verified students (.edu email) and 30% off any annual plan for registered non-profits and educators. Apply via the contact form below with proof of status.
      </>
    ),
  },
  {
    cat: "voice",
    q: "How do I clone my voice?",
    a: (
      <>
        Open <code>Voice Lab</code>, click <code>+ Clone voice</code> and either upload 60+ seconds of clean audio (WAV/MP3) or record live in your browser. Training takes 2–4 minutes. Pro and Studio only. You must own the voice or have written consent — see our <a href="/acceptable-use">acceptable-use policy</a>.
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
        Free: 14 days. Pro: 90 days. Studio: indefinitely (subject to fair-use limits of 500 GB). After expiry, project source files remain — only the rendered MP4 is purged. Re-rendering is free if you have credits.
      </>
    ),
  },
  {
    cat: "account",
    q: "How do I invite teammates?",
    a: (
      <>
        Go to <a href="/settings">Settings → Workspace → Team members</a> (coming soon — single-seat accounts only today). Studio will include 5 seats; additional seats are $19 each per month.
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
        Public API docs and SDKs are coming soon. Today MotionMax runs server-side only via Supabase Auth + RLS — programmatic access keys, webhooks and rate-limit dashboards will land alongside the public REST endpoints.
      </>
    ),
  },
  {
    cat: "api",
    q: "Are there rate limits?",
    a: (
      <>
        Once the public API ships, Studio plans will have 100 requests/minute and 10,000/day; we'll return <code>429</code> with a <code>Retry-After</code> header when you exceed it. Need higher limits? Contact us about an Enterprise plan.
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

type ContactTopic =
  | "General question"
  | "Billing & refunds"
  | "Bug report"
  | "Feature request"
  | "Voice cloning support"
  | "Account / login";

const TOPICS: ContactTopic[] = [
  "General question",
  "Billing & refunds",
  "Bug report",
  "Feature request",
  "Voice cloning support",
  "Account / login",
];

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
  const [topic, setTopic] = useState<ContactTopic>("General question");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [attachLogs, setAttachLogs] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSentDialog, setShowSentDialog] = useState(false);

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

  // Submit form via mailto: until a real ticket backend exists.
  // Keeps message routed to the same SUPPORT_EMAIL the rest of the app
  // already advertises (HelpPopover, Settings deletion fallback, etc.).
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !subject.trim() || !description.trim()) return;
    setIsSubmitting(true);
    const body =
      `From: ${name} <${email}>\n` +
      `Topic: ${topic}\n` +
      (attachLogs ? `Attach diagnostic logs: yes\n` : "") +
      `\n${description}\n`;
    const url =
      `mailto:${SUPPORT_EMAIL}` +
      `?subject=${encodeURIComponent(`[${topic}] ${subject}`)}` +
      `&body=${encodeURIComponent(body)}`;
    // Open the user's mail client. Setting window.location is the
    // most reliable cross-browser approach for mailto: handoff.
    window.location.href = url;
    // Show confirmation dialog after a short delay so the mailto handoff
    // has a beat to take effect.
    window.setTimeout(() => {
      setIsSubmitting(false);
      setShowSentDialog(true);
    }, 300);
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
                <div className="d">Email-based support · 1 business day</div>
              </a>
            </div>
          </div>

          {/* ─── System status ─────────────────────────────────────
              Status values are illustrative until we wire an actual
              status feed. Marking the section "Status overview" with
              a "Coming soon" tag keeps it honest — see scope rule #4. */}
          <div className="card" style={{ marginTop: 24 }}>
            <div className="h-row">
              <h3>System status</h3>
              <span className="soon-tag">Coming soon</span>
            </div>
            <div className="status-row">
              <span className="status-dot" aria-hidden="true" />
              <span className="t">Render queue</span>
              <span className="v">PENDING WIRE-UP</span>
            </div>
            <div className="status-row">
              <span className="status-dot" aria-hidden="true" />
              <span className="t">Voice synthesis</span>
              <span className="v">PENDING WIRE-UP</span>
            </div>
            <div className="status-row">
              <span className="status-dot" aria-hidden="true" />
              <span className="t">Stock library</span>
              <span className="v">PENDING WIRE-UP</span>
            </div>
            <div className="status-row" style={{ marginBottom: 0 }}>
              <span className="status-dot" aria-hidden="true" />
              <span className="t">API &amp; webhooks</span>
              <span className="v">PENDING WIRE-UP</span>
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

          {/* ─── Contact ───────────────────────────────────────── */}
          <div className="faq-section" id="contact">
            <div className="head">
              <h3>Still need help?</h3>
            </div>
            <div className="contact-grid">
              {/* Email-based for now: until a ticket backend exists, this
                  form composes a mailto: to SUPPORT_EMAIL on submit. */}
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
                        <option key={t} value={t}>{t}</option>
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
                  {/* Live chat — not implemented; mark "Coming soon". */}
                  <div className="touch-row disabled" aria-disabled="true">
                    <div className="ico">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    </div>
                    <div className="meta">
                      <div className="t">Live chat</div>
                      <div className="d">Coming soon · email us in the meantime</div>
                    </div>
                    <span className="soon-tag">Soon</span>
                  </div>
                  <a
                    className="touch-row"
                    href={`mailto:${SUPPORT_EMAIL}?subject=MotionMax%20support`}
                  >
                    <div className="ico">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="M22 7l-10 6L2 7" />
                      </svg>
                    </div>
                    <div className="meta">
                      <div className="t">{SUPPORT_EMAIL}</div>
                      <div className="d">For account &amp; billing</div>
                    </div>
                    <svg className="arr" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </a>
                  {/* Schedule-a-call — not implemented; mark Coming soon. */}
                  <div className="touch-row disabled" aria-disabled="true" style={{ marginBottom: 0 }}>
                    <div className="ico">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M8 2v4M16 2v4M3 10h18M9 14h2M14 14h2" />
                      </svg>
                    </div>
                    <div className="meta">
                      <div className="t">Schedule a call</div>
                      <div className="d">Studio onboarding — coming soon</div>
                    </div>
                    <span className="soon-tag">Soon</span>
                  </div>
                </div>

                <div className="card community-card">
                  <h3 style={{ marginBottom: 8 }}>Community</h3>
                  <p>Join other creators sharing tips, prompts and tutorials.</p>
                  {/* Community channels — not yet open to public. Marked
                      Coming soon so we don't ship dead links. */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn-ghost" disabled style={{ padding: "7px 12px", fontSize: 12.5 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M20 4H6.5a4.5 4.5 0 0 0 0 9H8v5l4-3h6.5a3.5 3.5 0 0 0 3.5-3.5V6a2 2 0 0 0-2-2z" />
                      </svg>
                      Discord
                    </button>
                    <button type="button" className="btn-ghost" disabled style={{ padding: "7px 12px", fontSize: 12.5 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 0a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.4 3.6 1 .1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 0z" />
                      </svg>
                      GitHub
                    </button>
                    <button type="button" className="btn-ghost" disabled style={{ padding: "7px 12px", fontSize: 12.5 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.3 18.3H5.7v-8.5h2.6zM7 8.7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11.3 9.6h-2.6v-4.1c0-1 0-2.3-1.4-2.3s-1.6 1.1-1.6 2.2v4.2h-2.6v-8.5h2.5v1.2c.4-.7 1.2-1.4 2.5-1.4 2.7 0 3.2 1.8 3.2 4z" />
                      </svg>
                      LinkedIn
                    </button>
                    <span className="soon-tag" style={{ alignSelf: "center" }}>Soon</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Submission confirmation — uses support-modal chrome (cyan-rim,
          blur backdrop). Mirrors v2-announcement vibe. */}
      <AlertDialog open={showSentDialog} onOpenChange={setShowSentDialog}>
        <AlertDialogContent className="support-modal-content">
          <AlertDialogHeader>
            <AlertDialogTitle style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: 20, letterSpacing: "-0.01em", color: "#ECEAE4" }}>
              Message handed off
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, color: "#8A9198", fontSize: 13.5, lineHeight: 1.55 }}>
                <p style={{ margin: 0 }}>
                  Your default mail app should have opened with a pre-filled draft to{" "}
                  <strong style={{ color: "#ECEAE4" }}>{SUPPORT_EMAIL}</strong>. Hit send there and we'll get back to you within one business day.
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "#5A6268" }}>
                  No mail client opened? Email{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "#14C8CC" }}>{SUPPORT_EMAIL}</a> directly.
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
