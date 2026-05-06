/**
 * TabPerformance — Phase 10. Wires admin_perf_kpis, admin_perf_phase_timing,
 * admin_workers_list, admin_request_worker_restart, admin_perf_throughput_14d,
 * admin_get_app_setting('worker_concurrency_override'), and
 * admin_set_worker_concurrency_override. Realtime channel on
 * `worker_heartbeats` invalidates the workers + KPI queries.
 */

import { useEffect, useMemo, useState, type JSX } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { BarChart } from "@/components/admin/_shared/BarChart";
import { BarTrack } from "@/components/admin/_shared/BarTrack";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill } from "@/components/admin/_shared/Pill";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

/* ── Types ──────────────────────────────────────────────────────────── */

interface PerfKpis {
  concurrency_in_flight: number; concurrency_total: number;
  avg_job_time_s: number; avg_job_time_prev_s: number;
  queue_depth: number; queue_over_sla: number;
  throughput_1h: number; throughput_per_min: number;
  mem_p95_pct: number; cpu_p95_pct: number;
}
interface PhaseTimingRow { phase: string; avg_s: number; p95_s: number; sample_size: number }
interface WorkerRow {
  worker_id: string; host: string | null; last_beat_at: string;
  in_flight: number; concurrency: number;
  memory_pct: number | null; cpu_pct: number | null;
  version: string | null; started_at: string;
  restart_requested: boolean; status: "healthy" | "degraded" | "dead" | string;
}
interface ThroughputRow { day: string; completed: number; failed: number }

type RpcFn = <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc as unknown as RpcFn;

const PHASE_COLOR: Record<string, string> = {
  script: "#7ad6e6", voiceover: "#a78bfa", audio: "#a78bfa", tts: "#a78bfa",
  image: "#F5B049", video: "#14C8CC", render: "#14C8CC",
  compose: "#5CD68D", mux: "#5CD68D", export: "#5CD68D",
};
function colorForPhase(phase: string): string {
  const k = phase.toLowerCase();
  for (const [needle, color] of Object.entries(PHASE_COLOR)) if (k.includes(needle)) return color;
  return "var(--cyan)";
}

/* ── Fetchers ───────────────────────────────────────────────────────── */

async function fetchKpis(): Promise<PerfKpis> {
  const { data, error } = await rpc<PerfKpis>("admin_perf_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_perf_kpis returned null");
  return data;
}
async function fetchPhaseTiming(): Promise<PhaseTimingRow[]> {
  const { data, error } = await rpc<PhaseTimingRow[]>("admin_perf_phase_timing");
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchWorkers(): Promise<WorkerRow[]> {
  const { data, error } = await rpc<WorkerRow[]>("admin_workers_list");
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchThroughput(): Promise<ThroughputRow[]> {
  const { data, error } = await rpc<ThroughputRow[]>("admin_perf_throughput_14d");
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchOverride(): Promise<number | null> {
  const { data, error } = await rpc<unknown>("admin_get_app_setting", { setting_key: "worker_concurrency_override" });
  if (error) throw new Error(error.message);
  return typeof data === "number" && data > 0 ? data : null;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return "0m";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
function pillVariantFor(status: string): "ok" | "warn" | "err" {
  if (status === "healthy") return "ok";
  if (status === "dead") return "err";
  return "warn";
}
function pctDelta(cur: number, prev: number): { text: string; dir: "up" | "down" | "neutral" } {
  if (!prev || prev === 0) return { text: "no baseline", dir: "neutral" };
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return { text: "flat wk/wk", dir: "neutral" };
  const sign = pct > 0 ? "+" : "";
  // Lower job-time is better → invert dir on the badge arrow.
  return { text: `${sign}${pct.toFixed(0)}% wk/wk`, dir: pct < 0 ? "up" : "down" };
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function ConcurrencyOverride({ initial }: { initial: number | null }): JSX.Element {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<number>(initial ?? 0);

  useEffect(() => { setValue(initial ?? 0); }, [initial]);

  const apply = useMutation({
    mutationFn: async (v: number) => {
      // Contract: -1 reverts to auto-tune. Slider 0 == "no override".
      const { data, error } = await rpc<unknown>("admin_set_worker_concurrency_override", { value: v === 0 ? -1 : v });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      toast.success(value === 0 ? "Reverted to auto-tune" : `Concurrency override set to ${value}`);
      void queryClient.invalidateQueries({ queryKey: adminKey("perf", "concurrency-override") });
    },
    onError: (err) => { toast.error(err instanceof Error ? err.message : "Failed to apply override"); },
  });

  return (
    <div className="card" style={{ marginBottom: 14, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ minWidth: 220 }}>
        <div className="lbl mono" style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--ink-mute)", textTransform: "uppercase" }}>Concurrency override</div>
        <div style={{ fontSize: 13, color: "var(--ink-dim)", marginTop: 4 }}>Manual cap (0 = auto). Worker picks up changes within 60 s.</div>
      </div>
      <div style={{ flex: 1, minWidth: 240, display: "flex", alignItems: "center", gap: 12 }}>
        <input type="range" min={0} max={60} step={1} value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          aria-label="Worker concurrency override" style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--cyan)", width: 60, textAlign: "right" }}>
          {value === 0 ? "auto" : `${value} slots`}
        </span>
      </div>
      <button type="button" className="btn-cyan sm" onClick={() => apply.mutate(value)} disabled={apply.isPending}>
        {apply.isPending ? "Applying…" : "Apply"}
      </button>
    </div>
  );
}

function WorkerCard({ w, onRestart }: { w: WorkerRow; onRestart: (w: WorkerRow) => void }): JSX.Element {
  const memWarn = (w.memory_pct ?? 0) > 80;
  return (
    <div className="card" style={{ padding: 12, background: "var(--panel-3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
        <div className="mono" style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }} title={w.worker_id}>{w.worker_id}</div>
        <Pill variant={pillVariantFor(w.status)} dot>{w.status}</Pill>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
        <div>
          <div className="muted" style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>Jobs</div>
          <div style={{ color: "var(--ink)", marginTop: 2 }}>{w.in_flight} / {w.concurrency || "—"}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>Mem</div>
          <div style={{ color: memWarn ? "var(--warn)" : "var(--ink)", marginTop: 2 }}>
            {w.memory_pct == null ? "—" : `${Math.round(Number(w.memory_pct))}%`}
          </div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase" }}>Up</div>
          <div style={{ color: "var(--ink)", marginTop: 2 }}>{formatUptime(w.started_at)}</div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn-mini" onClick={() => onRestart(w)} disabled={w.restart_requested}>
          <I.refresh /> {w.restart_requested ? "Pending" : "Restart"}
        </button>
      </div>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────────────── */

export function TabPerformance(): JSX.Element {
  const queryClient = useQueryClient();
  const [pendingRestart, setPendingRestart] = useState<WorkerRow | null>(null);

  const kpis = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("perf", "kpis"), queryFn: fetchKpis, refetchInterval: 15_000 });
  const phaseTiming = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("perf", "phase-timing"), queryFn: fetchPhaseTiming, refetchInterval: 30_000 });
  const workers = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("perf", "workers"), queryFn: fetchWorkers, refetchInterval: 15_000 });
  const throughput = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("perf", "throughput-14d"), queryFn: fetchThroughput });
  const concurrencyOverride = useQuery({ ...ADMIN_DEFAULT_QUERY_OPTIONS, queryKey: adminKey("perf", "concurrency-override"), queryFn: fetchOverride });

  // Realtime: any worker_heartbeats change ⇒ refresh workers + KPIs.
  useEffect(() => {
    const channel = supabase.channel("admin-tab-performance:worker_heartbeats")
      .on("postgres_changes", { event: "*", schema: "public", table: "worker_heartbeats" }, () => {
        void queryClient.invalidateQueries({ queryKey: adminKey("perf", "workers") });
        void queryClient.invalidateQueries({ queryKey: adminKey("perf", "kpis") });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

  useEffect(() => {
    if (kpis.error) toast.error("Performance KPIs failed", { id: "perf-kpis" });
    if (phaseTiming.error) toast.error("Phase timing failed", { id: "perf-phase" });
    if (workers.error) toast.error("Workers list failed", { id: "perf-workers" });
    if (throughput.error) toast.error("Throughput failed", { id: "perf-throughput" });
  }, [kpis.error, phaseTiming.error, workers.error, throughput.error]);

  const phaseRows = phaseTiming.data ?? [];
  const maxAvg = useMemo(() => phaseRows.reduce((m, r) => Math.max(m, Number(r.avg_s)), 0) || 1, [phaseRows]);

  async function handleConfirmRestart(): Promise<void> {
    if (!pendingRestart) return;
    const { error } = await rpc<unknown>("admin_request_worker_restart", { p_worker_id: pendingRestart.worker_id });
    if (error) throw new Error(error.message);
    void queryClient.invalidateQueries({ queryKey: adminKey("perf", "workers") });
  }

  function requestRestart(w: WorkerRow): void {
    if (w.status === "dead") { setPendingRestart(w); return; }
    rpc<unknown>("admin_request_worker_restart", { p_worker_id: w.worker_id })
      .then(({ error }) => {
        if (error) throw new Error(error.message);
        toast.success(`Restart requested · ${w.worker_id}`);
        void queryClient.invalidateQueries({ queryKey: adminKey("perf", "workers") });
      })
      .catch((err: unknown) => { toast.error(err instanceof Error ? err.message : "Restart failed"); });
  }

  if (kpis.isLoading) return <AdminLoading />;

  const k = kpis.data;
  const dash = "—";
  const jobTimeDelta = k ? pctDelta(Number(k.avg_job_time_s), Number(k.avg_job_time_prev_s)) : null;
  const tp = throughput.data ?? [];
  const tpCompleted = tp.map((r) => Number(r.completed));
  const tpFailed = tp.map((r) => Number(r.failed));
  const tpLabels = tp.map((r) => new Date(r.day).toLocaleDateString("en-US", { weekday: "narrow" }));
  const totalCompleted = tpCompleted.reduce((s, v) => s + v, 0);
  const totalFailed = tpFailed.reduce((s, v) => s + v, 0);
  const totalJobs = totalCompleted + totalFailed;
  const successRate = totalJobs === 0 ? 0 : (totalCompleted / totalJobs) * 100;
  const concurrencyIdle = k ? Math.max(0, Number(k.concurrency_total) - Number(k.concurrency_in_flight)) : 0;

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Worker concurrency" tone="cyan"
          value={k ? fmtNum(k.concurrency_in_flight) : dash}
          unit={k ? `/ ${k.concurrency_total || 0}` : undefined}
          delta={k ? `${concurrencyIdle} idle` : undefined} deltaDir="neutral" />
        <Kpi label="Avg job time"
          value={k ? Number(k.avg_job_time_s).toFixed(0) : dash} unit="s"
          delta={jobTimeDelta?.text} deltaDir={jobTimeDelta?.dir} />
        <Kpi label="Queue depth · now" tone={k && k.queue_over_sla > 0 ? "danger" : undefined}
          value={k ? fmtNum(k.queue_depth) : dash}
          delta={k ? `${k.queue_over_sla} over SLA (>5m)` : undefined}
          deltaDir={k && k.queue_over_sla > 0 ? "down" : "neutral"} />
        <Kpi label="Throughput · 1h"
          value={k ? fmtNum(k.throughput_1h) : dash} unit="jobs"
          delta={k ? `${Number(k.throughput_per_min).toFixed(1)}/min` : undefined} deltaDir="up" />
        <Kpi label="Memory · pod p95" value={k ? `${k.mem_p95_pct}` : dash} unit="%" delta="rolling 5m" deltaDir="neutral" />
        <Kpi label="CPU · pod p95" value={k ? `${k.cpu_p95_pct}` : dash} unit="%" delta="rolling 5m" deltaDir="neutral" />
      </div>

      <ConcurrencyOverride initial={concurrencyOverride.data ?? null} />

      <div className="cols-2-1">
        <div className="card">
          <div className="card-h"><div className="t">Pipeline phase timing</div><span className="lbl">avg / p95 · last 1h</span></div>
          {phaseTiming.isLoading ? <AdminLoading /> : phaseRows.length === 0 ? (
            <AdminEmpty title="No completed jobs in the last hour" hint="Phase timings appear once workers finish jobs." />
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {phaseRows.map((r) => {
                const avg = Number(r.avg_s);
                const p95 = Number(r.p95_s);
                return (
                  <div key={r.phase}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>{r.phase}</span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>
                        avg <b style={{ color: "var(--ink)" }}>{avg.toFixed(1)}s</b>
                        {" · "}p95 <b style={{ color: p95 > 100 ? "var(--warn)" : "var(--ink)" }}>{p95.toFixed(1)}s</b>
                      </span>
                    </div>
                    <BarTrack pct={(avg / maxAvg) * 100} color={colorForPhase(r.phase)} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-h"><div className="t">Workers</div><span className="lbl">{(workers.data ?? []).length} nodes · Render</span></div>
          {workers.isLoading ? <AdminLoading /> : (workers.data ?? []).length === 0 ? (
            <AdminEmpty title="No worker heartbeats" hint="Workers appear once they post their first heartbeat." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(workers.data ?? []).map((w) => <WorkerCard key={w.worker_id} w={w} onRestart={requestRestart} />)}
            </div>
          )}
        </div>
      </div>

      <SectionHeader title="Throughput · 14 days" />
      <div className="card">
        {throughput.isLoading ? <AdminLoading /> : tp.length === 0 ? (
          <AdminEmpty title="No throughput data" hint="Daily counts appear after the materialised view refreshes." />
        ) : (
          <>
            {/* Stacked: failed overlays the totals bar via a transparent positioning trick. */}
            <div style={{ position: "relative" }}>
              <BarChart data={tpCompleted.map((c, i) => c + tpFailed[i])} h={180} color="var(--cyan)" labels={tpLabels} />
              <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                <BarChart data={tpFailed} h={180} color="var(--warn)" />
              </div>
            </div>
            <div style={{ display: "flex", gap: 24, marginTop: 14, paddingTop: 12, borderTop: "1px dashed var(--line)", flexWrap: "wrap" }}>
              <div>
                <div className="lbl mono" style={{ fontSize: 9.5, letterSpacing: ".14em", color: "var(--ink-mute)", textTransform: "uppercase" }}>Completed</div>
                <div style={{ fontSize: 14, color: "var(--ink)", marginTop: 3 }}>{fmtNum(totalCompleted)}</div>
              </div>
              <div>
                <div className="lbl mono" style={{ fontSize: 9.5, letterSpacing: ".14em", color: "var(--ink-mute)", textTransform: "uppercase" }}>Failed</div>
                <div style={{ fontSize: 14, color: "var(--warn)", marginTop: 3 }}>{fmtNum(totalFailed)}</div>
              </div>
              <div>
                <div className="lbl mono" style={{ fontSize: 9.5, letterSpacing: ".14em", color: "var(--ink-mute)", textTransform: "uppercase" }}>Success rate</div>
                <div style={{ fontSize: 14, color: "var(--ink)", marginTop: 3 }}>{successRate.toFixed(1)}%</div>
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmDestructive
        open={pendingRestart !== null}
        onOpenChange={(o) => { if (!o) setPendingRestart(null); }}
        title={`Restart worker ${pendingRestart?.worker_id ?? ""}`}
        description={
          <span>
            This worker is marked <b>dead</b> (no heartbeat in 90 s). Restarting flips
            the <code className="mx-1">restart_requested</code> flag — Render's
            supervisor cycles the pod. Pending jobs may be retried.
          </span>
        }
        confirmText="RESTART" actionLabel="Restart worker"
        onConfirm={handleConfirmRestart}
        successMessage="Restart requested"
      />
    </div>
  );
}
