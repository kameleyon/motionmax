/**
 * TabNewsletter — Phase 15 admin Newsletter tab.
 *
 * Wires the live RPC surface (`admin_newsletter_kpis`,
 * `admin_create_campaign`, `admin_schedule_campaign`,
 * `admin_cancel_campaign`) plus a direct admin read on
 * `newsletter_campaigns`. The composer renders a desktop email preview
 * (`#fafaf6` paper, Georgia serif) that mirrors the live HTML on the
 * right while the admin types on the left.
 *
 * Send-test is a TODO stub for Phase 18 (no backend RPC yet).
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface NewsletterKpis {
  subscribers: number;
  subscribers_delta_7d: number;
  last_send_open_pct: number;
  last_send_click_pct: number;
  last_send_unsubs: number;
}

type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "cancelled";
type AudienceKey = "all" | "studio" | "pro" | "free";

interface CampaignRow {
  id: string;
  subject: string;
  audience: string;
  status: CampaignStatus;
  scheduled_for: string | null;
  sent_at: string | null;
  created_at: string;
}

interface SendRow { campaign_id: string; status: string }

interface CampaignAggregate {
  recipients: number;
  opened: number;
  clicked: number;
}

interface CreateRpcResult { id: string; status: string }
interface ScheduleRpcResult { id: string; status: string; scheduled_for: string }

type RpcFn = <T>(
  fn: string, args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

const AUDIENCE_OPTIONS: ReadonlyArray<{ k: AudienceKey; l: string; d: string; rpcArg: string }> = [
  { k: "all", l: "All subscribers", d: "Full opt-in list", rpcArg: "all_opted_in" },
  { k: "studio", l: "Studio plan only", d: "For pricier announcements", rpcArg: "plan:studio" },
  { k: "pro", l: "Pro plan only", d: "Mid-tier features", rpcArg: "plan:pro" },
  { k: "free", l: "Free users", d: "Activation / upsell", rpcArg: "plan:free" },
];

function statusPillVariant(s: CampaignStatus): PillVariant {
  switch (s) {
    case "scheduled": return "cyan";
    case "sending":   return "warn";
    case "sent":      return "ok";
    case "cancelled": return "default";
    default:          return "default";
  }
}

/* ── Fetchers ──────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<NewsletterKpis> {
  const { data, error } = await rpc<NewsletterKpis>("admin_newsletter_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_newsletter_kpis returned no data");
  return data;
}

async function fetchCampaigns(): Promise<CampaignRow[]> {
  const { data, error } = await supabase.from("newsletter_campaigns")
    .select("id,subject,audience,status,scheduled_for,sent_at,created_at")
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as CampaignRow[];
}

async function fetchSendsForCampaigns(ids: string[]): Promise<Map<string, CampaignAggregate>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("newsletter_sends")
    .select("campaign_id,status").in("campaign_id", ids);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as SendRow[];
  const agg = new Map<string, CampaignAggregate>();
  for (const id of ids) agg.set(id, { recipients: 0, opened: 0, clicked: 0 });
  for (const r of rows) {
    const a = agg.get(r.campaign_id);
    if (!a) continue;
    a.recipients += 1;
    if (r.status === "opened") a.opened += 1;
    if (r.status === "clicked") a.clicked += 1;
  }
  return agg;
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TabNewsletter(): JSX.Element {
  const qc = useQueryClient();

  // Composer state.
  const [subject, setSubject] = useState("Spring tools drop — voice cloning + new motion presets");
  const [headline, setHeadline] = useState("What's new in MotionMax · May edition");
  const [body, setBody] = useState(
    "Three things shipped this week:\n\n" +
    "• Voice cloning is now in public beta — train on 30s of clean audio.\n" +
    "• Six new cinematic motion presets (handheld, aerial, dolly-in, more).\n" +
    "• Render queue is 2.4× faster after our worker upgrade.\n\n" +
    "As always, hit reply if you have feedback. We read every email.",
  );
  const [audience, setAudience] = useState<AudienceKey>("all");
  const [ctaLabel, setCtaLabel] = useState("Open MotionMax");
  const [ctaUrl, setCtaUrl] = useState("https://motionmax.app");
  const [scheduleAt, setScheduleAt] = useState("");

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("news", "kpis"),
    queryFn: fetchKpis,
  });
  const campaigns = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("news", "campaigns"),
    queryFn: fetchCampaigns,
  });

  const campaignIds = useMemo(
    () => (campaigns.data ?? []).map((c) => c.id),
    [campaigns.data],
  );
  const sends = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("news", "sends", campaignIds.join(",")),
    queryFn: () => fetchSendsForCampaigns(campaignIds),
    enabled: campaignIds.length > 0,
  });

  useEffect(() => {
    if (kpis.error) toast.error("Newsletter KPIs failed", { id: "news-kpis" });
    if (campaigns.error) toast.error("Campaigns load failed", { id: "news-list" });
  }, [kpis.error, campaigns.error]);

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ["admin", "news"] });
  };

  function buildBodyHtml(): string {
    const safeBody = body
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\n/g, "<br/>");
    const safeHeadline = headline
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeCtaLabel = ctaLabel
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return [
      `<h2>${safeHeadline}</h2>`,
      `<p>${safeBody}</p>`,
      ctaUrl ? `<p><a href="${ctaUrl}">${safeCtaLabel} →</a></p>` : "",
    ].join("");
  }

  const audDef = AUDIENCE_OPTIONS.find((a) => a.k === audience) ?? AUDIENCE_OPTIONS[0];

  const saveDraftMut = useMutation({
    mutationFn: async (): Promise<CreateRpcResult> => {
      if (!subject.trim() || !body.trim()) {
        throw new Error("Subject and body are required");
      }
      const { data, error } = await rpc<CreateRpcResult>("admin_create_campaign", {
        p_subject: subject.trim(),
        p_body_html: buildBodyHtml(),
        p_body_text: body,
        p_audience: audDef.rpcArg,
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("create returned no id");
      return data;
    },
    onSuccess: () => { toast.success("Draft saved"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const scheduleMut = useMutation({
    mutationFn: async (): Promise<ScheduleRpcResult> => {
      if (!scheduleAt) throw new Error("Pick a send time");
      const when = new Date(scheduleAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        throw new Error("Schedule must be in the future");
      }
      const draft = await saveDraftMut.mutateAsync();
      const { data, error } = await rpc<ScheduleRpcResult>(
        "admin_schedule_campaign",
        { p_id: draft.id, p_scheduled_for: when.toISOString() },
      );
      if (error) throw new Error(error.message);
      if (!data) throw new Error("schedule returned no data");
      return data;
    },
    onSuccess: () => { toast.success("Campaign scheduled"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const sendTest = (): void => {
    toast.info("Send test → me — TODO Phase 18 (Resend stub)");
  };

  if (kpis.isLoading && campaigns.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const dash = "—";
  const subjectChars = subject.length;

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Subscribers" value={k ? fmtNum(k.subscribers) : dash}
          delta={k ? `+${fmtNum(k.subscribers_delta_7d)} · 7d` : undefined}
          deltaDir={k && k.subscribers_delta_7d > 0 ? "up" : "neutral"} />
        <Kpi label="Last open rate" value={k ? String(k.last_send_open_pct) : dash}
          unit="%" delta="last sent campaign" deltaDir="neutral" sparkColor="#5CD68D" />
        <Kpi label="Last click rate" value={k ? String(k.last_send_click_pct) : dash}
          unit="%" delta="industry avg ~2.6%" deltaDir="neutral" />
        <Kpi label="Unsubs · last send" value={k ? fmtNum(k.last_send_unsubs) : dash}
          delta="post-campaign opt-outs" deltaDir="neutral" />
      </div>

      <SectionHeader title="Compose newsletter" right={
        <>
          <button type="button" className="btn-ghost"
            onClick={() => saveDraftMut.mutate()} disabled={saveDraftMut.isPending}>
            {saveDraftMut.isPending ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="btn-ghost" onClick={sendTest}>
            Send test → me
          </button>
          <button type="button" className="btn-cyan"
            onClick={() => scheduleMut.mutate()} disabled={scheduleMut.isPending}>
            <I.send /> {scheduleMut.isPending ? "Scheduling…" : "Schedule send"}
          </button>
        </>
      } />

      <div className="cols-1-2">
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <div className="t">Audience</div>
              <span className="lbl">~{audDef.l.toLowerCase()}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {AUDIENCE_OPTIONS.map((o) => (
                <label key={o.k} style={{
                  display: "flex", gap: 10, alignItems: "flex-start", padding: 10,
                  borderRadius: 8,
                  background: audience === o.k ? "var(--cyan-dim)" : "var(--panel-3)",
                  border: "1px solid " + (audience === o.k
                    ? "rgba(20,200,204,.4)" : "var(--line)"),
                  cursor: "pointer",
                }}>
                  <input type="radio" name="news-audience"
                    checked={audience === o.k}
                    onChange={() => setAudience(o.k)}
                    style={{ marginTop: 3, accentColor: "var(--cyan)" }} />
                  <div>
                    <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>{o.l}</div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{o.d}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><div className="t">Content</div></div>
            <div className="field">
              <label htmlFor="news-subject">Subject line</label>
              <input id="news-subject" className="input" value={subject}
                onChange={(e) => setSubject(e.target.value)} />
              <div className="hint">
                {subjectChars} chars · keep under 60 for inbox preview
              </div>
            </div>
            <div className="field">
              <label htmlFor="news-headline">Headline</label>
              <input id="news-headline" className="input" value={headline}
                onChange={(e) => setHeadline(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="news-body">Body</label>
              <textarea id="news-body" className="input" rows={9} value={body}
                onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="field">
              <label>CTA button</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input" value={ctaLabel}
                  onChange={(e) => setCtaLabel(e.target.value)} style={{ flex: 1 }} />
                <input className="input mono" value={ctaUrl}
                  onChange={(e) => setCtaUrl(e.target.value)} style={{ flex: 2 }} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="news-when">Schedule for (optional)</label>
              <input id="news-when" className="input" type="datetime-local"
                value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            </div>
          </div>
        </div>

        <div>
          <div className="card-h">
            <div className="t">Preview</div>
            <span className="lbl">desktop · light</span>
          </div>
          <div className="nl-preview" style={{
            background: "#fafaf6", color: "#1a1a1a",
            fontFamily: "Georgia, 'Times New Roman', serif",
            padding: "32px 28px", borderRadius: 14,
            border: "1px solid var(--line)",
            boxShadow: "0 8px 24px -10px rgba(0,0,0,.4)",
          }}>
            <div className="brand" style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 20, marginBottom: 18, color: "#1a1a1a",
            }}>
              <b>Motion</b>Max
            </div>
            <h2 style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              fontSize: 28, fontWeight: 400, letterSpacing: "-.02em",
              margin: "0 0 16px", color: "#1a1a1a",
            }}>{headline}</h2>
            <p style={{
              fontSize: 15, lineHeight: 1.6, color: "#1a1a1a",
              whiteSpace: "pre-wrap", margin: "0 0 20px",
            }}>{body}</p>
            <a className="cta" href={ctaUrl || "#"} style={{
              display: "inline-block", background: "#0A0D0F", color: "#fff",
              padding: "11px 22px", borderRadius: 7, textDecoration: "none",
              fontFamily: "Inter, system-ui, sans-serif", fontSize: 13, fontWeight: 500,
            }}>{ctaLabel} →</a>
            <hr style={{ borderColor: "#e2dfd5", margin: "24px 0 14px" }} />
            <p style={{ fontSize: 11, color: "#888", margin: 0,
              fontFamily: "Inter, system-ui, sans-serif" }}>
              You're receiving this because you signed up at motionmax.app ·{" "}
              <a href="#" style={{ color: "#0FA6AE" }}>Unsubscribe</a> ·{" "}
              <a href="#" style={{ color: "#0FA6AE" }}>Update preferences</a>
            </p>
          </div>
        </div>
      </div>

      <SectionHeader title="Recent campaigns" />
      <div className="tbl-wrap">
        {campaigns.data && campaigns.data.length === 0
          ? <AdminEmpty title="No campaigns yet"
              hint="Save a draft above to see it here." />
          : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Sent</th>
                  <th style={{ textAlign: "right" }}>Recipients</th>
                  <th style={{ textAlign: "right" }}>Open</th>
                  <th style={{ textAlign: "right" }}>Click</th>
                  <th style={{ textAlign: "right" }}>Unsubs</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(campaigns.data ?? []).map((c) => {
                  const agg = sends.data?.get(c.id) ?? { recipients: 0, opened: 0, clicked: 0 };
                  const openPct = agg.recipients > 0
                    ? Math.round((agg.opened / agg.recipients) * 1000) / 10 : 0;
                  const clickPct = agg.recipients > 0
                    ? Math.round((agg.clicked / agg.recipients) * 1000) / 10 : 0;
                  const sentLabel = c.sent_at ? formatRel(c.sent_at)
                    : c.scheduled_for ? `at ${formatRel(c.scheduled_for)}` : "—";
                  return (
                    <tr key={c.id}>
                      <td className="strong">{c.subject}</td>
                      <td className="mono">{sentLabel}</td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {agg.recipients > 0 ? fmtNum(agg.recipients) : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {openPct > 0 ? `${openPct}%` : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {clickPct > 0 ? `${clickPct}%` : "—"}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>—</td>
                      <td><Pill variant={statusPillVariant(c.status)} dot>{c.status}</Pill></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}
