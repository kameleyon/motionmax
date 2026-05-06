/**
 * TabErrors — Phase 11 admin Errors tab.
 *
 * Wires:
 *   - admin_errors_kpis()                  → 4 KPI tiles
 *   - admin_error_groups(p_since, p_limit) → top error signatures table
 *   - admin_resolve_error_group(fp, notes) → typed-confirm Resolve action
 *   - direct read on `system_logs` (filtered to category='system_error') for
 *     the inline drill-down toggled by each row's Stack action.
 *
 * "Errors by surface" cards are derived client-side from `details->>surface`
 * on the grouped data so we don't need a separate RPC.
 *
 * Realtime: subscribes to `system_logs` and invalidates the groups + KPI
 * queries so new errors land in the table within a few seconds.
 */

import { useEffect, useMemo, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { Sparkline } from "@/components/admin/_shared/Sparkline";
import { formatRel, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ──────────────────────────────────────────────────────────── */

interface ErrorsKpis {
  errors_1h: number;
  errors_peak_24h: number;
  affected_users_1h: number;
  open_signatures: number;
}

interface ErrorGroupRow {
  fingerprint: string;
  event_type: string;
  events: number;
  users: number;
  first_seen: string;
  last_seen: string;
  sample_message: string | null;
  sample_details: Record<string, unknown> | null;
  resolved: boolean;
}

interface SystemLogRow {
  id: string;
  created_at: string;
  event_type: string;
  message: string | null;
  details: Record<string, unknown> | null;
  user_id: string | null;
}

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

type Period = "24h" | "7d" | "30d";
const PERIODS: ReadonlyArray<{ key: Period; label: string; ms: number }> = [
  { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

const SENTRY_BASE = "https://sentry.io/issues/";

/* ── Fetchers ───────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<ErrorsKpis> {
  const { data, error } = await rpc<ErrorsKpis>("admin_errors_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_errors_kpis returned null");
  return data;
}

async function fetchGroups(period: Period): Promise<ErrorGroupRow[]> {
  const since = new Date(Date.now() - (PERIODS.find((p) => p.key === period)?.ms ?? PERIODS[0].ms)).toISOString();
  const { data, error } = await rpc<ErrorGroupRow[]>("admin_error_groups", {
    p_since: since,
    p_limit: 50,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchDrilldown(fingerprint: string): Promise<SystemLogRow[]> {
  // Drill-down: the 5 most recent system_error rows for this fingerprint.
  // We try the `fingerprint` column first; on legacy rows it can be null,
  // in which case we fall back to event_type matching.
  const { data, error } = await supabase
    .from("system_logs")
    .select("id, created_at, event_type, message, details, user_id")
    .eq("category", "system_error")
    .or(`fingerprint.eq.${fingerprint},event_type.eq.${fingerprint}`)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  return (data ?? []) as SystemLogRow[];
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function severityFor(events: number): { label: "high" | "medium" | "low"; variant: PillVariant } {
  if (events > 30) return { label: "high", variant: "err" };
  if (events > 10) return { label: "medium", variant: "warn" };
  return { label: "low", variant: "default" };
}

function surfaceOf(row: ErrorGroupRow): "web" | "worker" | "edge" {
  const surface = row.sample_details && typeof row.sample_details === "object"
    ? (row.sample_details as Record<string, unknown>)["surface"]
    : null;
  const s = typeof surface === "string" ? surface.toLowerCase() : "";
  if (s.includes("worker")) return "worker";
  if (s.includes("edge") || s.includes("function")) return "edge";
  if (s.includes("web") || s.includes("client") || s.includes("browser")) return "web";
  // Fallback: classify from event_type prefix.
  const ev = row.event_type.toLowerCase();
  if (ev.startsWith("worker.") || ev.startsWith("render.")) return "worker";
  if (ev.startsWith("edge.") || ev.startsWith("function.")) return "edge";
  return "web";
}

const SURFACE_META: Record<"web" | "worker" | "edge", { label: string; color: string }> = {
  web: { label: "Web app", color: "#14C8CC" },
  worker: { label: "Worker · render", color: "#F5B049" },
  edge: { label: "Edge functions", color: "#a78bfa" },
};

/* ── Sub: error row ─────────────────────────────────────────────────── */

function ErrorRow({
  row,
  expanded,
  onToggle,
  onResolve,
}: {
  row: ErrorGroupRow;
  expanded: boolean;
  onToggle: () => void;
  onResolve: () => void;
}): JSX.Element {
  const sev = severityFor(Number(row.events));
  const drill = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("errors", "drill", row.fingerprint),
    queryFn: () => fetchDrilldown(row.fingerprint),
    enabled: expanded,
  });
  return (
    <>
      <tr>
        <td>
          <div className="strong mono" style={{ color: "#FFD18C", fontSize: 12 }}>
            {row.event_type}
          </div>
          <div className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>
            fp · {row.fingerprint.slice(0, 24)}
          </div>
        </td>
        <td><Pill variant={sev.variant} dot>{sev.label}</Pill></td>
        <td className="num strong" style={{ textAlign: "right" }}>{fmtNum(Number(row.events))}</td>
        <td className="num" style={{ textAlign: "right" }}>{fmtNum(Number(row.users))}</td>
        <td className="mono muted" style={{ fontSize: 11 }}>{formatRel(row.first_seen)}</td>
        <td className="mono" style={{ fontSize: 11 }}>{formatRel(row.last_seen)}</td>
        <td>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button type="button" className={"btn-mini" + (expanded ? " active" : "")} onClick={onToggle}>
              Stack
            </button>
            <button type="button" className="btn-mini" onClick={onResolve} disabled={row.resolved}>
              {row.resolved ? "Resolved" : "Resolve"}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ background: "var(--panel-3)", padding: 14 }}>
            {drill.isLoading ? (
              <div className="muted" style={{ fontSize: 12 }}>Loading samples…</div>
            ) : drill.error ? (
              <div className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>
                {drill.error instanceof Error ? drill.error.message : "Drill-down failed"}
              </div>
            ) : (drill.data ?? []).length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>No sample rows.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-dim)" }}>
                  Sample · {row.sample_message ?? "(no message)"}
                </div>
                {(drill.data ?? []).map((s) => (
                  <div key={s.id} style={{ borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>
                      {new Date(s.created_at).toLocaleString()} · {s.event_type}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 4 }}>
                      {s.message ?? "(no message)"}
                    </div>
                    {s.details && (
                      <pre className="mono" style={{ fontSize: 10.5, color: "var(--ink-mute)", marginTop: 4, maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}>
                        {JSON.stringify(s.details, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Component ──────────────────────────────────────────────────────── */

export function TabErrors(): JSX.Element {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("24h");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingResolve, setPendingResolve] = useState<ErrorGroupRow | null>(null);

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("errors", "kpis"),
    queryFn: fetchKpis,
    refetchInterval: 30_000,
  });
  const groups = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("errors", "groups", period),
    queryFn: () => fetchGroups(period),
    refetchInterval: 30_000,
  });

  // Realtime: any new system_error row ⇒ refresh the table + KPIs.
  useEffect(() => {
    const channel = supabase
      .channel("admin-tab-errors:system_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_logs", filter: "category=eq.system_error" },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["admin", "errors"] });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

  useEffect(() => {
    if (kpis.error) toast.error("Errors KPIs failed", { id: "err-kpis" });
    if (groups.error) toast.error("Error groups failed", { id: "err-groups" });
  }, [kpis.error, groups.error]);

  const rows = groups.data ?? [];

  // Group by surface client-side for the cols-3 cards.
  const bySurface = useMemo(() => {
    const acc: Record<"web" | "worker" | "edge", number> = { web: 0, worker: 0, edge: 0 };
    for (const r of rows) acc[surfaceOf(r)] += Number(r.events);
    return acc;
  }, [rows]);

  function toggleExpand(fp: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fp)) next.delete(fp); else next.add(fp);
      return next;
    });
  }

  async function handleResolve(): Promise<void> {
    if (!pendingResolve) return;
    const target = pendingResolve;
    const { error } = await rpc<unknown>("admin_resolve_error_group", {
      p_fingerprint: target.fingerprint,
      p_notes: null,
    });
    if (error) throw new Error(error.message);
    void queryClient.invalidateQueries({ queryKey: ["admin", "errors"] });
  }

  if (kpis.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const dash = "—";

  return (
    <div>
      <div className="kpi-grid">
        <Kpi
          label="Errors · 1h" tone="danger" sparkColor="#F5B049"
          value={k ? fmtNum(k.errors_1h) : dash}
          delta={k ? `↓ from ${fmtNum(k.errors_peak_24h)} peak` : undefined}
          deltaDir={k && k.errors_1h <= k.errors_peak_24h ? "down" : "up"}
        />
        <Kpi
          label="Affected users · 1h"
          value={k ? fmtNum(k.affected_users_1h) : dash}
          delta="last 60 min" deltaDir="neutral"
        />
        <Kpi
          label="Open signatures" sparkColor="#5CD68D"
          value={k ? fmtNum(k.open_signatures) : dash}
          delta="unresolved · 7d" deltaDir="up"
        />
        <Kpi
          label="Errors · peak 24h"
          value={k ? fmtNum(k.errors_peak_24h) : dash}
          delta="busiest hour" deltaDir="neutral"
        />
      </div>

      <SectionHeader
        title={`Top error signatures · ${period}`}
        right={
          <>
            <div style={{ display: "flex", gap: 0, background: "var(--panel-3)", borderRadius: 8, padding: 3, border: "1px solid var(--line)" }}>
              {PERIODS.map((p) => (
                <button
                  key={p.key} type="button"
                  onClick={() => setPeriod(p.key)}
                  className={"btn-ghost" + (period === p.key ? " active" : "")}
                  style={{ border: 0, padding: "5px 12px", borderRadius: 6 }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <a className="btn-ghost" href={SENTRY_BASE} target="_blank" rel="noreferrer noopener">
              <I.ext /> Open in Sentry
            </a>
          </>
        }
      />

      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Signature</th>
                <th>Severity</th>
                <th style={{ textAlign: "right" }}>Events</th>
                <th style={{ textAlign: "right" }}>Users</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th style={{ textAlign: "right", width: 160 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.isLoading ? (
                <tr><td colSpan={7}><AdminLoading /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7}>
                  <AdminEmpty title="No errors in this window" hint="Crashes & exceptions appear here as workers/edge fns log them." />
                </td></tr>
              ) : (
                rows.map((r) => (
                  <ErrorRow
                    key={r.fingerprint}
                    row={r}
                    expanded={expanded.has(r.fingerprint)}
                    onToggle={() => toggleExpand(r.fingerprint)}
                    onResolve={() => setPendingResolve(r)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <SectionHeader title="Errors by surface" />
      <div className="cols-3">
        {(["web", "worker", "edge"] as const).map((s) => {
          const meta = SURFACE_META[s];
          const events = bySurface[s];
          // Sparkline placeholder: deterministic shape from events count.
          const data = Array.from({ length: 14 }, (_, i) => {
            const seed = ((i * 17 + 5) % 100) / 100;
            return Math.max(0, Math.round((events / 14) * (1 + (seed - 0.5) * 0.8)));
          });
          return (
            <div className="card" key={s}>
              <div className="card-h">
                <div className="t">{meta.label}</div>
                <span className="lbl mono">{fmtNum(events)} events</span>
              </div>
              <Sparkline data={data} w={300} h={48} color={meta.color} />
            </div>
          );
        })}
      </div>

      <ConfirmDestructive
        open={pendingResolve !== null}
        onOpenChange={(o) => { if (!o) setPendingResolve(null); }}
        title="Resolve error group"
        description={
          <span>
            Marks every <code>system_error</code> row matching fingerprint
            <code className="mx-1">{pendingResolve?.fingerprint.slice(0, 24) ?? ""}</code>
            as resolved. New occurrences will reopen the group automatically.
          </span>
        }
        confirmText="RESOLVE"
        actionLabel="Resolve group"
        onConfirm={handleResolve}
        successMessage="Error group resolved"
      />
    </div>
  );
}
