import { useCallback, useMemo, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { exportRowsAsCsv } from "@/lib/csvExport";

import { I } from "@/components/admin/_shared/AdminIcons";
import { BarChart } from "@/components/admin/_shared/BarChart";
import { Donut } from "@/components/admin/_shared/Donut";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { num as fmtNum } from "@/components/admin/_shared/format";
import {
  ADMIN_DEFAULT_QUERY_OPTIONS,
  adminKey,
} from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */
type Period = "7d" | "30d" | "90d" | "12mo";
const PERIODS: Period[] = ["7d", "30d", "90d", "12mo"];
const PERIOD_DAYS: Record<Period, number> = { "7d": 7, "30d": 30, "90d": 90, "12mo": 365 };

type KpisRow = {
  dau_today: number; dau_yesterday: number; wau: number; mau: number;
  total_users: number; stickiness_pct: number;
};
type TimeseriesRow = { day: string; value: number };
type PlanMixRow = { plan_name: string; count: number };
/**
 * §11 Lens C1 — real funnel row shape returned by get_signup_funnel.
 * Replaces the old `FunnelRow` (signups / first_project / first_gen /
 * returned / paid) that the hardcoded 100% rows were built on top of.
 */
type FunnelStageRow = {
  stage:
    | "landing_visit"
    | "signup_started"
    | "signup_completed"
    | "first_generation_started"
    | "first_generation_completed"
    | "first_paid_conversion";
  count: number;
  pct_of_top: number;
};
type ProjectTypeRow = {
  project_type: string; count: number; last_7d: number; last_30d: number;
};
type CohortRow = {
  cohort_week: string; cohort_size: number;
  w0: number | null; w1: number | null; w2: number | null;
  w3: number | null; w4: number | null; w6: number | null; w8: number | null;
};

const PLAN_COLORS: Record<string, string> = {
  Studio: "#14C8CC", Pro: "#E4C875", Free: "#5A6268",
};
/* Feature chart swatches — brand aqua + gold variants only (no green/violet).
   Differentiation comes from tonal shifts within the brand palette per
   Canon Critical-4. */
const FEATURE_SWATCHES = ["#14C8CC", "#7ad6e6", "#0FA6AE", "#E4C875", "#C9A75A", "#5A6268"];
const MUTED_INFO_STYLE: React.CSSProperties = {
  padding: "18px 4px", fontSize: 12, color: "var(--ink-mute)",
  fontFamily: "var(--mono)", letterSpacing: ".04em",
};

const pct = (part: number, total: number): number => (total ? (part / total) * 100 : 0);
const pctFmt = (p: number, d = 1): string => p.toFixed(d) + "%";

/* ── Component ─────────────────────────────────────────────────────── */
export function TabAnalytics(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPeriod = searchParams.get("period");
  const period: Period = (PERIODS as string[]).includes(rawPeriod ?? "")
    ? (rawPeriod as Period)
    : "30d";

  const setPeriod = useCallback((next: Period) => {
    const params = new URLSearchParams(searchParams);
    params.set("period", next);
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const since = useMemo(
    () => new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000).toISOString(),
    [period],
  );

  const kpisQuery = useQuery({
    queryKey: adminKey("analytics", "kpis"),
    queryFn: async (): Promise<KpisRow> => {
      const { data, error } = await supabase.rpc("admin_analytics_kpis");
      if (error) throw error;
      return data as unknown as KpisRow;
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  const dauQuery = useQuery({
    queryKey: adminKey("analytics", "dau", period),
    queryFn: async (): Promise<TimeseriesRow[]> => {
      const { data, error } = await supabase.rpc("admin_analytics_timeseries", {
        p_metric: "dau", p_since: since,
      });
      if (error) throw error;
      return (data ?? []) as unknown as TimeseriesRow[];
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  const planMixQuery = useQuery({
    queryKey: adminKey("analytics", "plan-mix"),
    queryFn: async (): Promise<PlanMixRow[]> => {
      const { data, error } = await supabase.rpc("admin_analytics_plan_mix");
      if (error) throw error;
      return (data ?? []) as unknown as PlanMixRow[];
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  // §11 Lens C1 — real funnel. Calls the new get_signup_funnel(p_window_days)
  // function which uses funnel_events + auth.users + video_generation_jobs
  // + subscriptions instead of fudging the first three rows at 100%. Stages
  // with no event data return count=0 and are rendered as "—" below.
  const funnelQuery = useQuery({
    queryKey: adminKey("analytics", "funnel", period),
    queryFn: async (): Promise<FunnelStageRow[]> => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
        args?: Record<string, unknown>,
      ) => Promise<{ data: FunnelStageRow[] | null; error: { message: string } | null }>;
      const { data, error } = await rpc("get_signup_funnel", {
        p_window_days: PERIOD_DAYS[period],
      });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  const featuresQuery = useQuery({
    queryKey: adminKey("analytics", "project-types"),
    queryFn: async (): Promise<ProjectTypeRow[]> => {
      const { data, error } = await supabase.rpc("admin_analytics_project_type_mix");
      if (error) throw error;
      return (data ?? []) as unknown as ProjectTypeRow[];
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
  });

  // Cohort RPC may not exist on every shell — call defensively, retry off.
  const cohortQuery = useQuery({
    queryKey: adminKey("analytics", "cohort"),
    queryFn: async (): Promise<CohortRow[]> => {
      const rpc = supabase.rpc.bind(supabase) as unknown as (
        fn: string,
      ) => Promise<{ data: unknown; error: unknown }>;
      const { data, error } = await rpc("admin_analytics_cohort_retention");
      if (error) throw error;
      return (data ?? []) as CohortRow[];
    },
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    retry: false,
  });

  const kpis = kpisQuery.data;
  const dauValues = (dauQuery.data ?? []).map((r) => r.value);
  const planMix = planMixQuery.data ?? [];
  const planTotal = planMix.reduce((s, r) => s + r.count, 0);
  const funnelStages = funnelQuery.data ?? [];
  const features = (featuresQuery.data ?? []).slice(0, 6);
  const featureTotal = features.reduce((s, r) => s + r.count, 0);

  const dauDelta = useMemo(() => {
    if (!kpis || !kpis.dau_yesterday) return undefined;
    const change = pct(kpis.dau_today - kpis.dau_yesterday, kpis.dau_yesterday);
    return `${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs yest`;
  }, [kpis]);

  const mauPctOfTotal = useMemo(() => {
    if (!kpis || !kpis.total_users) return undefined;
    return `${pct(kpis.mau, kpis.total_users).toFixed(0)}% of total users`;
  }, [kpis]);

  const onExport = useCallback(() => {
    const rows = (dauQuery.data ?? []).map((r) => ({ day: r.day, dau: r.value }));
    if (!rows.length) { toast.error("No DAU data to export yet"); return; }
    const count = exportRowsAsCsv(
      rows,
      [{ key: "day", label: "Day" }, { key: "dau", label: "DAU" }],
      `motionmax-dau-${period}`,
    );
    toast.success(`Exported ${count} day${count === 1 ? "" : "s"} of DAU data`);
  }, [dauQuery.data, period]);

  // §11 Lens C1 — real funnel rendering. Old version hardcoded the first
  // three rows to `funnel.signups` with pctOfTop=100 (i.e. 100% retention
  // through onboarding, which is impossible). Now each stage shows its
  // real count + percentage relative to the top stage with non-zero data;
  // stages with count=0 render the dash "—" so the UI is honest about
  // gaps rather than fabricating engagement.
  const FUNNEL_STAGE_DISPLAY: Record<
    FunnelStageRow["stage"],
    { label: string; annotSuffix: string; color: string }
  > = {
    landing_visit:              { label: "Visited landing",         annotSuffix: " of top",       color: "#7ad6e6" },
    signup_started:             { label: "Started sign-up",         annotSuffix: " started",      color: "#14C8CC" },
    signup_completed:           { label: "Completed sign-up",       annotSuffix: " completed",    color: "#14C8CC" },
    first_generation_started:   { label: "First generation started", annotSuffix: " began gen",    color: "#14C8CC" },
    first_generation_completed: { label: "First generation done",   annotSuffix: " activated",    color: "#E4C875" },
    first_paid_conversion:      { label: "Upgraded to paid",        annotSuffix: " conversion",   color: "#E4C875" },
  };
  const funnelRows = useMemo(() => {
    return funnelStages.map((row) => {
      const display = FUNNEL_STAGE_DISPLAY[row.stage] ?? {
        label: row.stage, annotSuffix: "", color: "#5A6268",
      };
      const hasData = row.count > 0;
      // Render "—" when the stage has no data. Important for stages like
      // landing_visit before the marketing site is wired to record events
      // — the old behavior fabricated 100% which masked the gap.
      return {
        label: display.label,
        n: row.count,
        pctOfTop: hasData ? Number(row.pct_of_top) : 0,
        annot: hasData ? `${pctFmt(Number(row.pct_of_top))}${display.annotSuffix}` : "no data yet",
        color: display.color,
        hasData,
      };
    });
  }, [funnelStages]);

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="DAU · today" value={kpis ? fmtNum(kpis.dau_today) : "—"} delta={dauDelta} deltaDir="up" icon={<I.users />} sparkColor="var(--cyan)" />
        <Kpi label="WAU · 7d" value={kpis ? fmtNum(kpis.wau) : "—"} deltaDir="up" sparkColor="var(--cyan)" />
        <Kpi label="MAU · 30d" value={kpis ? fmtNum(kpis.mau) : "—"} delta={mauPctOfTotal} deltaDir="up" sparkColor="#14C8CC" />
        <Kpi
          label="Stickiness · DAU/MAU"
          value={kpis ? kpis.stickiness_pct.toFixed(1) : "—"}
          unit="%"
          delta="benchmark 13%"
          deltaDir={kpis && kpis.stickiness_pct < 13 ? "down" : "up"}
          tone={kpis && kpis.stickiness_pct < 13 ? "danger" : undefined}
        />
      </div>

      <SectionHeader
        title="Engagement"
        right={
          <>
            {PERIODS.map((p) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} className={"btn-ghost" + (period === p ? " active" : "")}>{p}</button>
            ))}
            <button type="button" className="btn-ghost" onClick={onExport}><I.download /> Export</button>
          </>
        }
      />

      <div className="cols-2-1">
        <div className="card">
          <div className="card-h">
            <div className="t">Daily active users · {period}</div>
            <span className="lbl">cyan = paying · grey = free</span>
          </div>
          {dauValues.length > 0 ? (
            <BarChart data={dauValues} h={200} color="var(--cyan)" />
          ) : (
            <div style={{ height: 200, display: "grid", placeItems: "center", color: "var(--ink-mute)", fontSize: 12 }}>
              {dauQuery.isLoading ? "Loading…" : "No DAU data for this period"}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-h">
            <div className="t">Plan mix</div>
            <span className="lbl">{fmtNum(planTotal)} users</span>
          </div>
          <Donut size={140} slices={planMix.map((r) => ({ value: r.count, color: PLAN_COLORS[r.plan_name] ?? "#5A6268", label: r.plan_name }))} />
          <div className="legend" style={{ marginTop: 14 }}>
            {planMix.map((r) => (
              <div className="row" key={r.plan_name}>
                <span className="sw" style={{ background: PLAN_COLORS[r.plan_name] ?? "#5A6268" }} />
                <span className="lbl">{r.plan_name}</span>
                <span className="v">{fmtNum(r.count)}</span>
                <span className="pct">{pctFmt(pct(r.count, planTotal))}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <SectionHeader title={`Funnel · last ${period}`} className="mt-6" />
      <div className="card">
        <div style={{ display: "grid", gap: 12 }}>
          {funnelRows.map((r) => (
            <div key={r.label} style={{ display: "grid", gridTemplateColumns: "180px 1fr 100px 140px", gap: 12, alignItems: "center" }}>
              <div style={{ fontSize: 13, color: "var(--ink-dim)" }}>{r.label}</div>
              <div className="bar-track" style={{ height: 18 }}>
                {/* §11 Lens C1: only paint a fill when the stage has real
                    data. Empty stages render an empty track instead of a
                    forced 1%-wide sliver, so the visual gap is honest. */}
                {r.hasData && (
                  <div className="bar-fill" style={{ width: Math.max(r.pctOfTop, 1) + "%", background: r.color }} />
                )}
              </div>
              <div className="mono strong" style={{ fontSize: 12, color: r.hasData ? "var(--ink)" : "var(--ink-mute)", textAlign: "right" }}>
                {r.hasData ? fmtNum(r.n) : "—"}
              </div>
              <div className="mono muted" style={{ fontSize: 11, letterSpacing: ".04em" }}>{r.annot}</div>
            </div>
          ))}
          {funnelRows.length === 0 && (
            <div style={{ color: "var(--ink-mute)", fontSize: 12, padding: "12px 0" }}>
              {funnelQuery.isLoading ? "Loading funnel…" : "No funnel data for this period"}
            </div>
          )}
        </div>
      </div>

      <div className="cols-3" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-h"><div className="t">Top countries</div></div>
          <div style={MUTED_INFO_STYLE}>Country tracking pending — Phase 18 GeoIP enrichment.</div>
        </div>
        <div className="card">
          <div className="card-h"><div className="t">Acquisition</div></div>
          <div style={MUTED_INFO_STYLE}>Referrer tracking pending — Phase 18 enrichment.</div>
        </div>
        <div className="card">
          <div className="card-h">
            <div className="t">Top features</div>
            <span className="lbl">use share</span>
          </div>
          <div className="legend">
            {features.map((r, i) => (
              <div className="row" key={r.project_type}>
                <span className="sw" style={{ background: FEATURE_SWATCHES[i] ?? FEATURE_SWATCHES[FEATURE_SWATCHES.length - 1] }} />
                <span className="lbl">{r.project_type}</span>
                <span className="v">{fmtNum(r.count)}</span>
                <span className="pct">{pctFmt(pct(r.count, featureTotal))}</span>
              </div>
            ))}
            {features.length === 0 && (
              <div className="mono muted" style={{ fontSize: 11, padding: "8px 0" }}>
                {featuresQuery.isLoading ? "Loading…" : "No project type data yet"}
              </div>
            )}
          </div>
        </div>
      </div>

      <SectionHeader
        title="Cohort retention · weekly"
        className="mt-6"
        right={<span className="muted mono" style={{ fontSize: 10.5, letterSpacing: ".06em" }}>% of cohort active in week N</span>}
      />
      <div className="card">
        <CohortHeatmap rows={cohortQuery.data ?? []} isError={cohortQuery.isError} isLoading={cohortQuery.isLoading} />
      </div>
    </div>
  );
}

/* ── Cohort heatmap ────────────────────────────────────────────────── */
function CohortHeatmap({
  rows, isError, isLoading,
}: { rows: CohortRow[]; isError: boolean; isLoading: boolean }): JSX.Element {
  if (isError || (!isLoading && rows.length === 0)) {
    return (
      <div style={{ padding: "20px 4px", color: "var(--ink-mute)", fontSize: 12, fontFamily: "var(--mono)", letterSpacing: ".04em" }}>
        Cohort retention analytics coming with the Phase 18 GeoIP + tracking infra.
      </div>
    );
  }
  const weekKeys: Array<keyof CohortRow> = ["w0", "w1", "w2", "w3", "w4", "w6", "w8"];
  const weekLabels = ["W0", "W1", "W2", "W3", "W4", "W6", "W8"];
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl" style={{ minWidth: 680 }}>
        <thead>
          <tr>
            <th>Cohort</th>
            <th style={{ textAlign: "right" }}>Size</th>
            {weekLabels.map((w) => <th key={w} style={{ textAlign: "right" }}>{w}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cohort_week}>
              <td className="mono strong">{r.cohort_week}</td>
              <td className="num" style={{ textAlign: "right" }}>{fmtNum(r.cohort_size)}</td>
              {weekKeys.map((wk) => {
                const v = r[wk] as number | null;
                return (
                  <td
                    key={wk as string}
                    className="num"
                    style={{
                      textAlign: "right",
                      background: v == null ? "transparent" : `rgba(20,200,204,${v / 110})`,
                      color: v == null ? "var(--ink-mute)" : v > 40 ? "#0A0D0F" : "var(--ink)",
                      fontWeight: v == null ? 400 : 500,
                    }}
                  >
                    {v == null ? "—" : v + "%"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
