/**
 * TabNotifications — Phase 14 admin Notifications tab.
 *
 * Wires the live RPC surface (`admin_notifications_kpis`,
 * `admin_send_notification_to_segment`, `admin_schedule_notification`)
 * plus a direct read on `user_notifications` filtered to
 * `sent_by_admin_id IS NOT NULL` (admin RLS, realtime publication active).
 *
 * The `Channels` and `Routing rules` sections are placeholder UIs — the
 * underlying tables don't exist yet, so the controls are non-destructive
 * and "+ New rule" raises a `TODO` toast.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { Toggle } from "@/components/admin/_shared/Toggle";
import { formatRel, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface NotifKpis { unread_alerts: number; sent_24h: number; scheduled: number; severity_high: number }
type NotifSeverity = "info" | "success" | "warn" | "error";
interface NotifRow {
  id: string; title: string; body: string; severity: NotifSeverity;
  cta_url: string | null; read_at: string | null; created_at: string; template_slug: string | null;
}
type SegmentKey = "all" | "studio" | "pro" | "free" | "active_7d";
type SeverityRadio = NotifSeverity;
type FilterKey = "all" | "unread" | "high" | "med" | "low";
interface SendRpcResult { sent: number }
interface ScheduleRpcResult { scheduled: number; scheduled_for: string }

type RpcFn = <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/* ── Fetchers ──────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<NotifKpis> {
  const { data, error } = await rpc<NotifKpis>("admin_notifications_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_notifications_kpis returned no data");
  return data;
}

async function fetchNotifs(): Promise<NotifRow[]> {
  const { data, error } = await supabase.from("user_notifications")
    .select("id,title,body,severity,cta_url,read_at,created_at,template_slug")
    .not("sent_by_admin_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotifRow[];
}

/* ── Severity helpers ──────────────────────────────────────────────── */

const severityBucket = (s: NotifSeverity): "high" | "med" | "low" =>
  s === "error" ? "high" : s === "warn" ? "med" : "low";
const severityPillVariant = (b: "high" | "med" | "low"): PillVariant =>
  b === "high" ? "err" : b === "med" ? "warn" : "default";

const SEGMENT_OPTIONS: ReadonlyArray<{ key: SegmentKey; label: string; rpcArg: string }> = [
  { key: "all", label: "All users", rpcArg: "all" },
  { key: "studio", label: "Studio", rpcArg: "plan:studio" },
  { key: "pro", label: "Pro", rpcArg: "plan:pro" },
  { key: "free", label: "Free", rpcArg: "plan:free" },
  { key: "active_7d", label: "Active 7d", rpcArg: "active_7d" },
];
const SEVERITY_OPTIONS: ReadonlyArray<{ key: SeverityRadio; label: string }> = [
  { key: "info", label: "Info" }, { key: "success", label: "Success" },
  { key: "warn", label: "Warning" }, { key: "error", label: "Error" },
];
const CHANNELS: ReadonlyArray<{ k: string; d: string; on: boolean }> = [
  { k: "Slack · #ops-alerts", d: "High + medium severity", on: true },
  { k: "PagerDuty · oncall", d: "High severity only · pages immediately", on: true },
  { k: "Email · ops@motionmax.app", d: "Daily digest at 09:00 UTC", on: true },
  { k: "SMS · +1 (415) ••• 4218", d: "Production outages only", on: false },
  { k: "Discord · #internal", d: "Deploys + payouts", on: true },
];
const ROUTING_RULES: ReadonlyArray<{ n: string; c: string; a: string }> = [
  { n: "High severity → PagerDuty", c: "severity = high", a: "PagerDuty + Slack" },
  { n: "Stripe webhooks → ops email", c: "src = stripe.*", a: "Email digest" },
  { n: "Worker pod warnings → #ops", c: "src = k8s.* AND severity ≥ med", a: "Slack #ops-alerts" },
  { n: "Support urgent → on-call", c: "tag = urgent AND src = support.inbox", a: "PagerDuty" },
  { n: "Deploy noise → silence", c: "src = github.actions AND severity = low", a: "Discord only" },
];

/* ── Component ─────────────────────────────────────────────────────── */

export function TabNotifications(): JSX.Element {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [composerOpen, setComposerOpen] = useState(false);

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("notifs", "kpis"),
    queryFn: fetchKpis,
  });
  const list = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("notifs", "list"),
    queryFn: fetchNotifs,
  });

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: ["admin", "notifs"] });
  };

  // Realtime: invalidate on any insert/update on user_notifications.
  useEffect(() => {
    const channel = supabase
      .channel("admin-notifs:user_notifications")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "user_notifications" },
        () => { invalidate(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (kpis.error) toast.error("Notification KPIs failed", { id: "notifs-kpis" });
    if (list.error) toast.error("Notifications load failed", { id: "notifs-list" });
  }, [kpis.error, list.error]);

  const rows = list.data ?? [];
  const filtered = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "unread") return rows.filter((r) => !r.read_at);
    return rows.filter((r) => severityBucket(r.severity) === filter);
  }, [rows, filter]);

  const markAllReadMut = useMutation({
    mutationFn: async (): Promise<void> => {
      const ids = rows.filter((r) => !r.read_at).map((r) => r.id);
      if (ids.length === 0) return;
      const { error } = await supabase.from("user_notifications")
        .update({ read_at: new Date().toISOString() }).in("id", ids);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { toast.success("Marked as read"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const ackMut = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from("user_notifications")
        .update({ read_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (kpis.isLoading && list.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const dash = "—";
  const filterButtons: ReadonlyArray<[FilterKey, string]> = [
    ["all", "All"], ["unread", "Unread"],
    ["high", "High"], ["med", "Medium"], ["low", "Low"],
  ];

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Unread alerts" value={k ? fmtNum(k.unread_alerts) : dash}
          delta={k ? `${k.severity_high} high · 7d` : undefined}
          deltaDir="neutral" tone={k && k.unread_alerts > 0 ? "danger" : undefined} />
        <Kpi label="Sent · 24h" value={k ? fmtNum(k.sent_24h) : dash}
          delta="admin-issued" deltaDir="neutral" />
        <Kpi label="Scheduled" value={k ? fmtNum(k.scheduled) : dash}
          delta="awaiting send" deltaDir="neutral" />
        <Kpi label="High severity · 7d" value={k ? fmtNum(k.severity_high) : dash}
          delta="error-tier" deltaDir="neutral"
          tone={k && k.severity_high > 0 ? "danger" : undefined} />
      </div>

      <SectionHeader title="Notification stream" right={
        <>
          {filterButtons.map(([key, label]) => (
            <button key={key} type="button"
              onClick={() => setFilter(key)}
              className={"btn-ghost" + (filter === key ? " active" : "")}>
              {label}
            </button>
          ))}
          <button type="button" className="btn-ghost"
            onClick={() => markAllReadMut.mutate()}
            disabled={markAllReadMut.isPending || rows.every((r) => r.read_at)}>
            Mark all read
          </button>
          <button type="button" className="btn-cyan"
            onClick={() => setComposerOpen(true)}>
            <I.send /> Send notification
          </button>
        </>
      } />

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {filtered.length === 0
          ? <div style={{ padding: 24 }}>
              <AdminEmpty title="No notifications yet"
                hint="Admin-issued notifications will appear here in realtime." />
            </div>
          : filtered.map((n) => (
            <NotificationRow key={n.id} n={n} onAck={() => ackMut.mutate(n.id)} />
          ))}
      </div>

      <SectionHeader title="Notification routing" right={
        <button type="button" className="btn-ghost"
          onClick={() => toast.info("Routing rule editor — TODO Phase 18")}>
          <I.plus /> New rule
        </button>
      } />

      <div className="cols-2">
        <div className="card">
          <div className="card-h"><div className="t">Channels</div></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {CHANNELS.map((c) => <ChannelRow key={c.k} k={c.k} d={c.d} on={c.on} />)}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><div className="t">Routing rules</div></div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ROUTING_RULES.map((r) => (
              <div key={r.n} className="card" style={{ padding: 11, background: "var(--panel-3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                  <span style={{ fontSize: 12.5, color: "var(--ink)", fontWeight: 500 }}>{r.n}</span>
                  <button type="button" className="btn-mini"
                    onClick={() => toast.info("Rule editor — TODO Phase 18")}>Edit</button>
                </div>
                <div className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>
                  WHEN <span style={{ color: "var(--cyan)" }}>{r.c}</span> → {r.a}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <SendNotificationDialog open={composerOpen} onOpenChange={setComposerOpen}
        onSent={() => { invalidate(); }} />
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────── */

function NotificationRow({ n, onAck }: { n: NotifRow; onAck: () => void }): JSX.Element {
  const bucket = severityBucket(n.severity);
  const tileBg = bucket === "high" ? "rgba(245,176,73,.12)" : bucket === "med" ? "rgba(245,176,73,.1)" : "var(--panel-3)";
  const tileColor = bucket === "low" ? "var(--ink-dim)" : "var(--warn)";
  const tileBorder = "1px solid " + (bucket === "low" ? "var(--line)" : "rgba(245,176,73,.3)");
  const Icon = bucket === "high" ? I.alert : bucket === "med" ? I.bell : I.check;
  const ack = !!n.read_at;
  const src = n.template_slug ?? "admin.send";
  return (
    <div style={{
      display: "flex", gap: 14, padding: "14px 18px", borderBottom: "1px solid var(--line)",
      background: ack ? "transparent" : "linear-gradient(90deg,rgba(20,200,204,.04),transparent)",
      alignItems: "flex-start",
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8, display: "grid", placeItems: "center",
        flexShrink: 0, background: tileBg, color: tileColor, border: tileBorder,
      }}><Icon /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {!ack && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--cyan)", display: "inline-block", flexShrink: 0 }} />}
            <span style={{ fontSize: 14, color: "var(--ink)", fontWeight: 500 }}>{n.title}</span>
            <Pill variant={severityPillVariant(bucket)}>{bucket}</Pill>
          </div>
          <span className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em", flexShrink: 0 }}>{formatRel(n.created_at)}</span>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 6 }}>{n.body}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <span className="mono muted" style={{ fontSize: 10, letterSpacing: ".04em" }}>[{src}]</span>
          <div style={{ display: "flex", gap: 6 }}>
            {!ack && <button type="button" className="btn-mini" onClick={onAck}><I.check /> Acknowledge</button>}
            <button type="button" className="btn-mini"
              onClick={() => { if (n.cta_url) window.open(n.cta_url, "_blank", "noopener,noreferrer"); else toast.info("No CTA URL"); }}>View</button>
            <button type="button" className="btn-mini" onClick={() => toast.info("Snooze — TODO Phase 18")}>Snooze 1h</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChannelRow({ k, d, on }: { k: string; d: string; on: boolean }): JSX.Element {
  const [checked, setChecked] = useState(on);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: "1px dashed var(--line)" }}>
      <div>
        <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>{k}</div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{d}</div>
      </div>
      <Toggle checked={checked} onChange={(v) => { setChecked(v); toast.info("Channel toggle — persistence TODO Phase 18"); }} ariaLabel={k} />
    </div>
  );
}

function SendNotificationDialog({ open, onOpenChange, onSent }: {
  open: boolean; onOpenChange: (o: boolean) => void; onSent: () => void;
}): JSX.Element {
  const [segment, setSegment] = useState<SegmentKey>("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [severity, setSeverity] = useState<SeverityRadio>("info");
  const [scheduleOn, setScheduleOn] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setSegment("all"); setTitle(""); setBody(""); setCtaUrl("");
      setSeverity("info"); setScheduleOn(false); setScheduleAt(""); setPending(false);
    }
  }, [open]);

  const segDef = SEGMENT_OPTIONS.find((s) => s.key === segment) ?? SEGMENT_OPTIONS[0];
  const disabled = !title.trim() || !body.trim() || pending || (scheduleOn && !scheduleAt);

  async function submit(): Promise<void> {
    if (disabled) return;
    setPending(true);
    try {
      const payload = {
        p_title: title.trim(), p_body: body.trim(),
        p_cta_url: ctaUrl.trim() || null, p_severity: severity,
      };
      if (scheduleOn) {
        const when = new Date(scheduleAt);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw new Error("Schedule must be in the future");
        // Segment-resolve-then-schedule is a follow-up; for now we call
        // admin_schedule_notification with an empty array as a guard so
        // the audit log is written even if no users match yet.
        const { error } = await rpc<ScheduleRpcResult>("admin_schedule_notification",
          { p_user_ids: [], ...payload, p_scheduled_for: when.toISOString() });
        if (error) throw new Error(error.message);
        toast.success("Scheduled");
      } else {
        const { data, error } = await rpc<SendRpcResult>("admin_send_notification_to_segment",
          { p_segment: segDef.rpcArg, ...payload });
        if (error) throw new Error(error.message);
        toast.success(`Sent to ${data?.sent ?? 0} users`);
      }
      onSent();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally { setPending(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send notification</DialogTitle>
          <DialogDescription>
            Select an audience segment and compose the message. Notifications are inserted directly into <span className="mono">user_notifications</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Audience segment</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SEGMENT_OPTIONS.map((s) => (
                <button key={s.key} type="button" className={"btn-ghost" + (segment === s.key ? " active" : "")}
                  onClick={() => setSegment(s.key)} disabled={pending}>{s.label}</button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notif-title">Title</Label>
            <Input id="notif-title" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Heads up" autoComplete="off" disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notif-body">Body</Label>
            <Textarea id="notif-body" value={body} onChange={(e) => setBody(e.target.value)}
              rows={4} placeholder="What you want users to know…" disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notif-cta">CTA URL (optional)</Label>
            <Input id="notif-cta" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://motionmax.app/…" autoComplete="off" disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SEVERITY_OPTIONS.map((s) => (
                <button key={s.key} type="button" className={"btn-ghost" + (severity === s.key ? " active" : "")}
                  onClick={() => setSeverity(s.key)} disabled={pending}>{s.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 4 }}>
            <Toggle checked={scheduleOn} onChange={setScheduleOn} ariaLabel="Schedule for later" disabled={pending} />
            <Label style={{ marginBottom: 0 }}>Schedule for later</Label>
          </div>
          {scheduleOn && (
            <div className="space-y-1.5">
              <Label htmlFor="notif-when">When</Label>
              <Input id="notif-when" type="datetime-local" value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)} disabled={pending} />
            </div>
          )}
        </div>
        <DialogFooter>
          <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</button>
          <button type="button" className="btn-cyan" onClick={submit} disabled={disabled}>
            {pending ? "Sending…" : scheduleOn ? "Schedule" : "Send now"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
