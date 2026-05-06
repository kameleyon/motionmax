/**
 * TabAnnouncements — Phase 16. Wires `admin_announcements_kpis`,
 * `admin_create_announcement`, `admin_archive_announcement` plus a direct
 * admin SELECT on `announcements`. Composer state is local until publish.
 * Realtime subscription invalidates queries when peers publish.
 */
import { useEffect, useMemo, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

interface AnnouncementsKpis {
  active: number;
  created_7d: number;
  dismissed_24h: number;
  critical_open: number;
}
type Severity = "info" | "warn" | "critical" | "feature";
type Channel = "banner" | "modal" | "toast" | "email" | "push";

interface AnnouncementRow {
  id: string;
  title: string;
  body_md: string;
  severity: Severity;
  cta_label: string | null;
  cta_url: string | null;
  audience: Record<string, unknown> | null;
  starts_at: string;
  ends_at: string | null;
  active: boolean;
  created_at: string;
}

/** RPC shim — Phase 16 RPCs land in generated types in a follow-up. */
type RpcFn = <T>(
  fn: string, args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

/** `announcements` is admin-readable but not yet in generated types — cast
 *  the builder via unknown so we keep strict TS without polluting global
 *  Database typings. */
type FromAny = (table: string) => {
  select: (cols: string) => {
    order: (col: string, opts: { ascending: boolean }) => Promise<{
      data: unknown[] | null; error: { message: string } | null;
    }>;
  };
};
const fromAny = (supabase.from as unknown) as FromAny;

const CHANNEL_OPTIONS: ReadonlyArray<{ k: Channel; l: string; d: string }> = [
  { k: "banner", l: "Top banner", d: "Slim bar at top of app" },
  { k: "modal",  l: "Modal on next visit", d: "One-time, dismissable" },
  { k: "toast",  l: "Toast notification", d: "Bottom-right, auto-dismiss" },
  { k: "email",  l: "Email blast", d: "Goes to all opted-in users" },
  { k: "push",   l: "Push notification", d: "Native browser push" },
];

const SEVERITY_OPTIONS: ReadonlyArray<{ k: Severity; l: string }> = [
  { k: "info", l: "Info" },
  { k: "warn", l: "Warning" },
  { k: "critical", l: "Critical" },
  { k: "feature", l: "Feature" },
];

const TARGET_OPTIONS = [
  "All", "Studio", "Pro", "Free", "Active 7d", "Inactive 30d", "EU only",
] as const;
type Target = typeof TARGET_OPTIONS[number];

/* ── Fetchers ──────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<AnnouncementsKpis> {
  const { data, error } = await rpc<AnnouncementsKpis>("admin_announcements_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_announcements_kpis returned no data");
  return data;
}

async function fetchAnnouncements(): Promise<AnnouncementRow[]> {
  const { data, error } = await fromAny("announcements")
    .select("id,title,body_md,severity,cta_label,cta_url,audience,starts_at,ends_at,active,created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as AnnouncementRow[]);
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TabAnnouncements(): JSX.Element {
  const qc = useQueryClient();

  // Composer state (local until publish)
  const [title, setTitle] = useState<string>("Heads up");
  const [body, setBody] = useState<string>(
    "Render queues will be paused 02:00–02:30 UTC tonight for a worker upgrade.",
  );
  const [channel, setChannel] = useState<Channel>("banner");
  const [severity, setSeverity] = useState<Severity>("info");
  const [ctaLabel, setCtaLabel] = useState<string>("");
  const [ctaUrl, setCtaUrl] = useState<string>("");
  const [targets, setTargets] = useState<Set<Target>>(new Set<Target>(["All"]));
  const [scheduleAt, setScheduleAt] = useState<string>(""); // datetime-local
  const [confirmEnd, setConfirmEnd] = useState<AnnouncementRow | null>(null);

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("announce", "kpis"),
    queryFn: fetchKpis,
  });
  const list = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("announce", "list"),
    queryFn: fetchAnnouncements,
  });

  useEffect(() => {
    if (kpis.error) toast.error("Announcement KPIs failed", { id: "announce-kpis" });
    if (list.error) toast.error("Announcement list failed", { id: "announce-list" });
  }, [kpis.error, list.error]);

  // Realtime: any insert/update/delete on `announcements` invalidates the
  // tab's queries so a co-admin publishing in another browser surfaces here.
  useEffect(() => {
    const ch = supabase
      .channel("admin-announcements:announcements")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "announcements" },
        () => { qc.invalidateQueries({ queryKey: ["admin", "announce"] }); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [qc]);

  const toggleTarget = (t: Target): void => {
    setTargets((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t); else n.add(t);
      if (n.size === 0) n.add("All");
      return n;
    });
  };

  const audienceJson = useMemo<Record<string, unknown>>(() => {
    const arr = Array.from(targets);
    if (arr.length === 0 || arr.includes("All")) return { plan: "all" };
    return { segments: arr };
  }, [targets]);

  const publishMut = useMutation({
    mutationFn: async (vars: { startsAt: string | null }): Promise<{ id: string }> => {
      const { data, error } = await rpc<{ id: string }>("admin_create_announcement", {
        p_title: title.trim() || "Untitled",
        p_body_md: body.trim(),
        p_severity: severity,
        p_cta_label: ctaLabel.trim() || null,
        p_cta_url: ctaUrl.trim() || null,
        p_audience: { ...audienceJson, channel },
        p_starts_at: vars.startsAt,
        p_ends_at: null,
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("admin_create_announcement returned no id");
      return data;
    },
    onSuccess: () => {
      toast.success("Announcement published");
      qc.invalidateQueries({ queryKey: ["admin", "announce"] });
      setBody("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (kpis.isLoading && list.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const dash = "—";
  const live = (list.data ?? []).filter((r) => r.active);

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Active announcements" value={k ? fmtNum(k.active) : dash}
          delta={k ? `${k.critical_open} critical open` : undefined}
          deltaDir={k && k.critical_open > 0 ? "down" : "neutral"}
          tone={k && k.critical_open > 0 ? "danger" : undefined}
          icon={<I.bell />} />
        <Kpi label="Created · 7d" value={k ? fmtNum(k.created_7d) : dash}
          delta="rolling 7d" deltaDir="neutral" />
        <Kpi label="CTA click rate" value={dash} unit="%"
          delta="awaits Phase 16.4" deltaDir="neutral" />
        <Kpi label="Dismissed · 24h" value={k ? fmtNum(k.dismissed_24h) : dash}
          delta="last 24h" deltaDir="neutral" />
      </div>

      <SectionHeader title="Compose announcement" right={
        <>
          <button type="button" className="btn-ghost"
            onClick={() => {
              const el = document.getElementById("announce-schedule") as HTMLInputElement | null;
              el?.focus();
            }}>
            Schedule
          </button>
          <input id="announce-schedule" type="datetime-local"
            value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
            style={{
              background: "var(--panel-3)", border: "1px solid var(--line)",
              color: "var(--ink)", borderRadius: 6, padding: "4px 8px",
              fontSize: 11, fontFamily: "var(--mono)",
            }} />
          <button type="button" className="btn-cyan"
            disabled={publishMut.isPending || !body.trim()}
            onClick={() => publishMut.mutate({
              startsAt: scheduleAt ? new Date(scheduleAt).toISOString() : new Date().toISOString(),
            })}>
            <I.bell /> {publishMut.isPending ? "Publishing…" : "Publish now"}
          </button>
        </>
      } />

      <div className="cols-1-2">
        <div className="card">
          <div className="field">
            <Label>Channel</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {CHANNEL_OPTIONS.map((o) => (
                <RadioRow key={o.k} active={channel === o.k}
                  onSelect={() => setChannel(o.k)} label={o.l} desc={o.d}
                  name="ann-channel" />
              ))}
            </div>
          </div>

          <div className="field">
            <Label htmlFor="ann-title">Title</Label>
            <Input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Heads up" />
          </div>

          <div className="field">
            <Label htmlFor="ann-body">Message</Label>
            <Textarea id="ann-body" rows={5} value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What changed, what users should know…" />
          </div>

          <div className="field">
            <Label>CTA (optional)</Label>
            <div style={{ display: "flex", gap: 8 }}>
              <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)}
                placeholder="Read more" style={{ flex: 1 }} />
              <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="https://…" className="font-mono" style={{ flex: 2 }} />
            </div>
          </div>

          <div className="field">
            <Label>Severity</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {SEVERITY_OPTIONS.map((s) => (
                <button key={s.k} type="button"
                  onClick={() => setSeverity(s.k)}
                  className={"btn-mini" + (severity === s.k ? " active" : "")}
                  style={severity === s.k ? {
                    color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)",
                    background: "var(--cyan-dim)",
                  } : undefined}>
                  {s.l}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <Label>Targeting</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {TARGET_OPTIONS.map((t) => {
                const on = targets.has(t);
                return (
                  <button key={t} type="button" onClick={() => toggleTarget(t)}
                    className={"btn-mini" + (on ? " active" : "")}
                    style={on ? {
                      color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)",
                      background: "var(--cyan-dim)",
                    } : undefined}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div>
          <div className="card-h">
            <div className="t">Preview · {channel}</div>
            <span className="lbl">live composition</span>
          </div>
          <PreviewByChannel channel={channel} title={title} body={body}
            ctaLabel={ctaLabel || "Read more"} />
        </div>
      </div>

      <SectionHeader title="Live announcements" />
      <div className="cols-2">
        {live.length === 0
          ? <AdminEmpty title="No active announcements" hint="Publish one above to broadcast to users." />
          : live.map((a) => (
            <LiveCard key={a.id} row={a}
              onEdit={() => toast.info("Inline edit coming Phase 18")}
              onEnd={() => setConfirmEnd(a)} />
          ))}
      </div>

      {confirmEnd && (
        <ConfirmDestructive open={!!confirmEnd}
          onOpenChange={(o) => { if (!o) setConfirmEnd(null); }}
          title={`End "${confirmEnd.title}"`}
          description={
            <>This announcement stops broadcasting immediately. Users mid-render will see it disappear within the realtime roundtrip (&lt;5s).</>
          }
          confirmText="END"
          actionLabel="End now"
          successMessage="Announcement ended"
          onConfirm={async () => {
            const { error } = await rpc<{ id: string; archived: boolean }>(
              "admin_archive_announcement", { p_id: confirmEnd.id },
            );
            if (error) throw new Error(error.message);
            qc.invalidateQueries({ queryKey: ["admin", "announce"] });
          }} />
      )}
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────────────────── */

function RadioRow({ active, onSelect, label, desc, name }: {
  active: boolean; onSelect: () => void; label: string; desc: string; name: string;
}): JSX.Element {
  return (
    <label style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      padding: 9, borderRadius: 7,
      background: active ? "var(--cyan-dim)" : "var(--panel-3)",
      border: "1px solid " + (active ? "rgba(20,200,204,.4)" : "var(--line)"),
      cursor: "pointer",
    }}>
      <input type="radio" name={name} checked={active}
        onChange={onSelect} style={{ marginTop: 3, accentColor: "var(--cyan)" }} />
      <div>
        <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500 }}>{label}</div>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{desc}</div>
      </div>
    </label>
  );
}

const FRAME: CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10 };
const MONO_LBL: CSSProperties = { fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 };

function PreviewByChannel({ channel, title, body, ctaLabel }: {
  channel: Channel; title: string; body: string; ctaLabel: string;
}): JSX.Element {
  if (channel === "banner") {
    return (
      <div style={{ ...FRAME, overflow: "hidden" }}>
        <div style={{
          background: "linear-gradient(90deg,rgba(20,200,204,.18),rgba(20,200,204,.04))",
          borderBottom: "1px solid rgba(20,200,204,.3)", padding: "10px 18px",
          display: "flex", alignItems: "center", gap: 12, color: "var(--ink)", fontSize: 13.5,
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--cyan)", boxShadow: "0 0 0 3px rgba(20,200,204,.18)" }} />
          <span>{body || "—"}</span>
          <button type="button" className="btn-mini" style={{ marginLeft: "auto" }}>{ctaLabel}</button>
          <span style={{ color: "var(--ink-mute)", cursor: "pointer" }} aria-label="Close"><I.x /></span>
        </div>
        <div style={{ padding: "30px 18px", color: "var(--ink-mute)", fontSize: 12, fontFamily: "var(--mono)", letterSpacing: ".04em", textAlign: "center" }}>
          — rest of the app —
        </div>
      </div>
    );
  }
  if (channel === "modal") {
    return (
      <div style={{ ...FRAME, padding: 32, textAlign: "center" }}>
        <div style={{ maxWidth: 360, margin: "0 auto", background: "var(--panel-2)", border: "1px solid var(--line-2)", borderRadius: 14, padding: 24, boxShadow: "0 30px 60px -20px rgba(0,0,0,.5)" }}>
          <div style={{ width: 42, height: 42, margin: "0 auto 12px", borderRadius: 10, background: "var(--cyan-dim)", color: "var(--cyan)", display: "grid", placeItems: "center" }}><I.bell /></div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 500, color: "var(--ink)", marginBottom: 8 }}>{title || "Heads up"}</div>
          <div style={{ fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.55, marginBottom: 18 }}>{body || "—"}</div>
          <button type="button" className="btn-cyan sm" style={{ width: "100%", justifyContent: "center" }}>Got it</button>
        </div>
      </div>
    );
  }
  if (channel === "toast") {
    return (
      <div style={{ ...FRAME, padding: 24, minHeight: 200, position: "relative" }}>
        <div style={{ position: "absolute", bottom: 18, right: 18, maxWidth: 300, background: "var(--panel-2)", border: "1px solid var(--line-2)", borderRadius: 10, padding: 12, boxShadow: "0 12px 30px -10px rgba(0,0,0,.5)", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ width: 28, height: 28, borderRadius: 7, background: "var(--cyan-dim)", color: "var(--cyan)", display: "grid", placeItems: "center", flexShrink: 0 }}><I.bell /></div>
          <div style={{ fontSize: 12.5, color: "var(--ink-dim)", lineHeight: 1.5 }}>{body || "—"}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="muted mono" style={MONO_LBL}>{channel === "email" ? "Email subject" : "Push title"}</div>
      <div style={{ fontSize: 14, color: "var(--ink)", marginBottom: 14 }}>{title || "MotionMax — important update"}</div>
      <div className="muted mono" style={MONO_LBL}>Body</div>
      <div style={{ fontSize: 13.5, color: "var(--ink-dim)", lineHeight: 1.6 }}>{body || "—"}</div>
    </div>
  );
}

function LiveCard({ row, onEdit, onEnd }: {
  row: AnnouncementRow; onEdit: () => void; onEnd: () => void;
}): JSX.Element {
  const aud = row.audience as { plan?: string; segments?: string[]; channel?: string } | null;
  const channel = (aud?.channel as Channel | undefined) ?? "banner";
  const audienceLabel = aud?.segments?.length
    ? aud.segments.join(" · ")
    : (aud?.plan === "all" || !aud?.plan) ? "All" : aud.plan;
  const expiresLabel = row.ends_at
    ? `Expires ${formatRel(row.ends_at)}`
    : "Open-ended";
  const stat = (label: string, value: ReactNode): JSX.Element => (
    <div>
      <div className="muted mono" style={{
        fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase",
      }}>{label}</div>
      <div style={{ marginTop: 3, color: "var(--ink)" }}>{value}</div>
    </div>
  );
  return (
    <div className="card">
      <div className="card-h">
        <div className="t">{row.title}</div>
        <Pill variant="cyan" dot>live</Pill>
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4,1fr)",
        gap: 12, fontSize: 12, marginBottom: 10,
      }}>
        {stat("Channel", channel)}
        {stat("Audience", audienceLabel)}
        {stat("Views", "—")}
        {stat("Clicks", "—")}
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        borderTop: "1px dashed var(--line)", paddingTop: 10,
      }}>
        <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: ".06em" }}>
          {expiresLabel}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-mini" onClick={onEdit}>Edit</button>
          <button type="button" className="btn-mini danger" onClick={onEnd}>End now</button>
        </div>
      </div>
    </div>
  );
}
