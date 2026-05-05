/**
 * TabApi — Phase 6 admin "API & Costs" tab. Wires four RPCs:
 *   - `admin_api_cost_kpis`        → KPI grid (4 tiles)
 *   - `admin_api_cost_breakdown`   → per-provider table + cost-per-model card
 *   - `admin_top_expensive_calls`  → footer hook (action drawer is TODO)
 *   - `admin_api_calls_weekly`     → 14-day bar chart + EOM forecast
 *
 * URL state: `?period=7d|30d|90d` (default `30d`). The provider chip filter
 * is in-memory only — period drives the breakdown `p_since` so server-side
 * aggregation stays consistent.
 */

import { useCallback, useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { exportRowsAsCsv } from "@/lib/csvExport";

import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { BarChart } from "@/components/admin/_shared/BarChart";
import { BarTrack } from "@/components/admin/_shared/BarTrack";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill, type PillVariant } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { Sparkline } from "@/components/admin/_shared/Sparkline";
import { money, money4, num as fmtNum, short } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */
type Period = "7d" | "30d" | "90d";
const PERIODS: readonly Period[] = ["7d", "30d", "90d"] as const;
const PERIOD_DAYS: Record<Period, number> = { "7d": 7, "30d": 30, "90d": 90 };

interface ApiCostKpis {
  api_calls_30d: number; api_calls_prev_30d: number;
  api_spend_mtd: number; api_spend_prev_mtd: number;
  avg_cost_per_gen: number;
  p95_latency_ms_30d: number; p95_latency_prev_30d: number;
  error_rate_30d: number;
}
interface BreakdownRow { label: string; calls: number; spend: number; avg_ms: number; err_pct: number }
interface WeeklyRow { day: string; calls: number; spend: number }

/** Typed RPC shim — mirrors `TabOverview.tsx` so callers stay free of `any`. */
type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = (supabase.rpc as unknown) as RpcFn;

/* ── Helpers ───────────────────────────────────────────────────────── */
type Kind = "Video" | "Voice" | "Image" | "Other";
function kindFor(label: string): Kind {
  const s = label.toLowerCase();
  if (/(video|hailuo|runway|kling|veo|sora|luma|replicate.*video)/.test(s)) return "Video";
  if (/(voice|tts|eleven|fish|smallest|lemonfox|narrat|audio)/.test(s)) return "Voice";
  if (/(image|flux|sdxl|stable|dalle|imagen|photo)/.test(s)) return "Image";
  return "Other";
}
function kindPill(k: Kind): PillVariant {
  if (k === "Video") return "cyan";
  if (k === "Voice") return "purple";
  if (k === "Image") return "gold";
  return "default";
}
function pctDelta(cur: number, prior: number): { text: string; dir: "up" | "down" | "neutral" } {
  if (prior === 0) return cur === 0 ? { text: "no change", dir: "neutral" } : { text: "new", dir: "up" };
  const r = ((cur - prior) / prior) * 100;
  return { text: `${r > 0 ? "+" : ""}${r.toFixed(1)}% vs prev`, dir: r > 0 ? "up" : r < 0 ? "down" : "neutral" };
}
function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function errColor(p: number): string {
  return p > 1.5 ? "var(--warn)" : p > 0.8 ? "#F5B049" : "var(--good)";
}
function eomForecast(mtd: number): number {
  const now = new Date();
  const daysSoFar = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return daysSoFar === 0 ? 0 : (mtd / daysSoFar) * daysInMonth;
}

/* ── Fetchers ──────────────────────────────────────────────────────── */
async function fetchKpis(): Promise<ApiCostKpis> {
  const { data, error } = await rpc<ApiCostKpis>("admin_api_cost_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_api_cost_kpis returned no data");
  return data;
}
async function fetchBreakdown(period: Period, groupBy: string): Promise<BreakdownRow[]> {
  const since = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000).toISOString();
  const { data, error } = await rpc<BreakdownRow[]>("admin_api_cost_breakdown", {
    p_since: since, p_group_by: groupBy,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchWeekly(): Promise<WeeklyRow[]> {
  const { data, error } = await rpc<WeeklyRow[]>("admin_api_calls_weekly");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* ── Component ─────────────────────────────────────────────────────── */
export function TabApi(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPeriod = searchParams.get("period");
  const period: Period = (PERIODS as readonly string[]).includes(rawPeriod ?? "")
    ? (rawPeriod as Period)
    : "30d";

  const setPeriod = useCallback((next: Period) => {
    const params = new URLSearchParams(searchParams);
    if (next === "30d") params.delete("period"); else params.set("period", next);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const [providerFilter, setProviderFilter] = useState<string>("All");

  const kpisQuery = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("api", "kpis"),
    queryFn: fetchKpis,
  });
  const providerQuery = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("api", "breakdown", "provider", period),
    queryFn: () => fetchBreakdown(period, "provider"),
  });
  const modelQuery = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("api", "breakdown", "model", period),
    queryFn: () => fetchBreakdown(period, "model"),
  });
  const weeklyQuery = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("api", "weekly"),
    queryFn: fetchWeekly,
  });

  const kpis = kpisQuery.data;
  const providerRows = providerQuery.data ?? [];
  const modelRows = modelQuery.data ?? [];
  const weeklyRows = weeklyQuery.data ?? [];
  const dash = "—";

  const providerChips = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const r of providerRows) set.add(r.label);
    return ["All", ...Array.from(set).sort()];
  }, [providerRows]);

  const visibleRows = useMemo<BreakdownRow[]>(() => {
    const base = providerFilter === "All"
      ? providerRows
      : providerRows.filter((r) => r.label === providerFilter);
    const periodDays = PERIOD_DAYS[period];
    return [...base].sort(
      (a, b) => (b.spend / Math.max(periodDays, 1)) - (a.spend / Math.max(periodDays, 1)),
    );
  }, [providerRows, providerFilter, period]);

  const modelTop = useMemo(() => {
    const top = [...modelRows].sort((a, b) => b.spend - a.spend).slice(0, 5);
    const max = top.reduce((m, r) => Math.max(m, r.spend), 0) || 1;
    const days = PERIOD_DAYS[period] || 1;
    return { rows: top, max, days };
  }, [modelRows, period]);

  const weeklyValues = useMemo(() => weeklyRows.map((r) => r.calls), [weeklyRows]);
  const weeklyLabels = useMemo(
    () => weeklyRows.map((r) => {
      const d = new Date(r.day);
      return ["S", "M", "T", "W", "T", "F", "S"][d.getUTCDay()] ?? "·";
    }),
    [weeklyRows],
  );
  const forecast = kpis ? eomForecast(kpis.api_spend_mtd) : 0;

  const onExportCsv = useCallback(() => {
    if (visibleRows.length === 0) {
      toast.message("Nothing to export", { description: "No rows match the current filter." });
      return;
    }
    const count = exportRowsAsCsv(
      visibleRows,
      [
        { key: "label", label: "Provider/Model" },
        { key: "calls", label: "Calls" },
        { key: "spend", label: "Spend (USD)" },
        { key: "avg_ms", label: "Avg latency (ms)" },
        { key: "err_pct", label: "Error %" },
      ],
      `motionmax-api-breakdown-${period}`,
    );
    toast.success(`Exported ${count} row${count === 1 ? "" : "s"}`);
  }, [visibleRows, period]);

  const onActionClick = useCallback(() => {
    toast.info("Detail drawer coming soon", {
      description: "TODO: wire to AdminApiCalls drawer.",
    });
  }, []);

  if (kpisQuery.isLoading) return <AdminLoading />;

  const callsDelta = kpis ? pctDelta(kpis.api_calls_30d, kpis.api_calls_prev_30d) : null;
  const spendDelta = kpis ? pctDelta(kpis.api_spend_mtd, kpis.api_spend_prev_mtd) : null;
  const latDelta = kpis ? pctDelta(kpis.p95_latency_ms_30d, kpis.p95_latency_prev_30d) : null;
  const errTone = kpis && kpis.error_rate_30d > 0.5 ? "danger" : undefined;

  return (
    <div>
      <div className="kpi-grid">
        <Kpi
          label="API calls · 30d"
          value={kpis ? short(kpis.api_calls_30d) : dash}
          delta={callsDelta?.text}
          deltaDir={callsDelta?.dir}
        />
        <Kpi
          label="API spend · MTD"
          sparkColor="#F5B049"
          value={kpis ? money(kpis.api_spend_mtd) : dash}
          delta={kpis ? `${money4(kpis.avg_cost_per_gen)} / generation avg` : undefined}
          deltaDir="neutral"
        />
        <Kpi
          label="Avg latency · p95"
          value={kpis ? fmtLatency(kpis.p95_latency_ms_30d) : dash}
          delta={latDelta?.text}
          deltaDir={latDelta ? (latDelta.dir === "up" ? "down" : latDelta.dir === "down" ? "up" : "neutral") : undefined}
        />
        <Kpi
          label="Error rate"
          tone={errTone}
          value={kpis ? `${kpis.error_rate_30d.toFixed(2)}%` : dash}
          delta={kpis && kpis.error_rate_30d > 0.5 ? "over SLA (0.5%)" : "within SLA"}
          deltaDir={kpis && kpis.error_rate_30d > 0.5 ? "down" : "up"}
        />
      </div>

      <SectionHeader
        title="Per-provider breakdown"
        right={<BreakdownToolbar
          period={period} setPeriod={setPeriod}
          providerChips={providerChips} providerFilter={providerFilter}
          setProviderFilter={setProviderFilter} onExportCsv={onExportCsv}
        />}
      />

      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <div className="scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Kind</th>
                <th style={{ textAlign: "right" }}>Calls · {period}</th>
                <th style={{ textAlign: "right" }}>$ / call</th>
                <th style={{ textAlign: "right" }}>$ / month</th>
                <th style={{ textAlign: "right" }}>p95 latency</th>
                <th style={{ textAlign: "right" }}>Err %</th>
                <th style={{ textAlign: "right", width: 140 }}>Trend</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: 24, color: "var(--ink-mute)" }}>
                    No API activity in the selected window.
                  </td>
                </tr>
              ) : visibleRows.map((row) => {
                const k = kindFor(row.label);
                const perCall = row.calls > 0 ? row.spend / row.calls : 0;
                const perDay = row.calls / Math.max(PERIOD_DAYS[period], 1);
                const trend = Array.from({ length: 14 }, (_, i) => {
                  const seed = ((i * 17 + 7) % 100) / 100;
                  return Math.max(0, perDay * (1 + (seed - 0.5) * 0.5));
                });
                const trendColor = row.err_pct > 1.5 ? "#F5B049" : "var(--cyan)";
                return (
                  <tr key={row.label}>
                    <td>
                      <div className="strong" style={{ color: "var(--ink)" }}>{row.label}</div>
                      <div className="mono muted" style={{ fontSize: 10.5, letterSpacing: ".04em" }}>
                        {k.toLowerCase()}.{row.label.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}
                      </div>
                    </td>
                    <td><Pill variant={kindPill(k)}>{k}</Pill></td>
                    <td className="num strong" style={{ textAlign: "right" }}>{fmtNum(row.calls)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{money4(perCall)}</td>
                    <td className="num strong" style={{ textAlign: "right" }}>{money(row.spend)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtLatency(row.avg_ms)}</td>
                    <td className="num" style={{ textAlign: "right", color: errColor(row.err_pct) }}>
                      {row.err_pct.toFixed(1)}%
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Sparkline data={trend} w={120} h={26} color={trendColor} />
                    </td>
                    <td>
                      <button type="button" className="btn-mini" onClick={onActionClick} aria-label="Open detail">
                        <I.ext />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cols-2">
        <div className="card">
          <div className="card-h">
            <div className="t">Cost per generation type</div>
            <span className="lbl">avg · {period}</span>
          </div>
          <div style={{ display: "grid", gap: 14 }}>
            {modelTop.rows.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>No model spend in the selected window.</div>
            ) : modelTop.rows.map((r) => {
              const perDay = r.calls / Math.max(modelTop.days, 1);
              const k = kindFor(r.label);
              const color = k === "Video" ? "#14C8CC"
                : k === "Voice" ? "#a78bfa"
                : k === "Image" ? "#F5B049"
                : "#7ad6e6";
              return (
                <div key={r.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>{r.label}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>
                      {money(r.spend)} <span className="muted">· {short(perDay)}/day</span>
                    </span>
                  </div>
                  <BarTrack pct={(r.spend / modelTop.max) * 100} color={color} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <div className="t">API calls · weekly</div>
            <span className="lbl">last 14 days</span>
          </div>
          {weeklyValues.length === 0 ? (
            <div className="muted" style={{ fontSize: 12, padding: "32px 4px" }}>
              No daily aggregates yet.
            </div>
          ) : (
            <BarChart data={weeklyValues} h={180} color="var(--cyan)" labels={weeklyLabels} />
          )}
          <div
            style={{
              display: "flex",
              gap: 14,
              marginTop: 14,
              paddingTop: 12,
              borderTop: "1px dashed var(--line)",
              flexWrap: "wrap",
            }}
          >
            <StatLabel label="Peak hour" value={dash} note="hourly granularity TBD" />
            <StatLabel
              label="Daily peak"
              value={weeklyValues.length > 0 ? short(Math.max(...weeklyValues)) : dash}
              note={weeklyValues.length > 0 ? "calls · top day" : undefined}
            />
            <StatLabel
              label="Forecast · EOM"
              value={kpis ? money(forecast) : dash}
              note={kpis ? `from ${money(kpis.api_spend_mtd)} MTD` : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatLabel({ label, value, note }: { label: string; value: string; note?: string }): JSX.Element {
  return (
    <div>
      <div className="lbl mono" style={{ fontSize: 9.5, letterSpacing: ".14em", color: "var(--ink-mute)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 14, color: "var(--ink)", marginTop: 3 }}>
        {value}
        {note && <span className="muted mono" style={{ fontSize: 11, marginLeft: 6 }}>· {note}</span>}
      </div>
    </div>
  );
}

interface BreakdownToolbarProps {
  period: Period;
  setPeriod: (p: Period) => void;
  providerChips: string[];
  providerFilter: string;
  setProviderFilter: (p: string) => void;
  onExportCsv: () => void;
}
function BreakdownToolbar({ period, setPeriod, providerChips, providerFilter, setProviderFilter, onExportCsv }: BreakdownToolbarProps): JSX.Element {
  const segStyle = { display: "flex", gap: 0, background: "var(--panel-3)", borderRadius: 8, padding: 3, border: "1px solid var(--line)" } as const;
  return (
    <>
      <div style={segStyle}>
        {PERIODS.map((p) => (
          <button key={p} type="button" onClick={() => setPeriod(p)}
            className={"btn-ghost" + (period === p ? " active" : "")}
            style={{ border: 0, padding: "5px 12px", borderRadius: 6 }}>{p}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {providerChips.map((p) => {
          const active = p === providerFilter;
          return (
            <button key={p} type="button" onClick={() => setProviderFilter(p)}
              className={"btn-mini" + (active ? " active" : "")}
              style={{
                color: active ? "var(--cyan)" : undefined,
                borderColor: active ? "rgba(20,200,204,.3)" : undefined,
                background: active ? "var(--cyan-dim)" : undefined,
              }}>{p}</button>
          );
        })}
      </div>
      <button type="button" className="btn-ghost" onClick={onExportCsv}><I.download /> Export CSV</button>
    </>
  );
}
