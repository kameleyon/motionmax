/**
 * TabGenerations — Phase 9 admin Generations tab. Wires the Phase 9 RPCs:
 *   - `admin_generations_kpis()`            — 4 KPI tiles
 *   - `admin_generations_list(...)`         — Recent generations table
 *   - `admin_force_complete_job(...)`       — drilldown action
 *   - `admin_requeue_dead_letter(...)`      — dead-letter queue
 *   - `admin_retry_generation` (existing)   — drilldown action
 *   - `admin_cancel_job_with_refund` (exist) — drilldown action
 *
 * Realtime: subscribes to `video_generation_jobs` row changes and
 * invalidates the list query so a job flipping to `failed` refreshes
 * the row's status pill within ~1 round-trip without a manual refetch.
 *
 * Drilldown: shown inline below the table when `selectedId` is set —
 * full payload + actions guarded by `<ConfirmDestructive>`.
 */

import { useEffect, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill } from "@/components/admin/_shared/Pill";
import { SearchRow } from "@/components/admin/_shared/SearchRow";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel, money, num as fmtNum } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

interface GenKpis {
  gens_today: number; gens_yesterday: number;
  success_rate_24h: number; success_rate_prev: number;
  median_time_s: number | null; median_time_prev_s: number | null;
  in_queue: number; over_sla: number;
  spark_today: number[];
}

interface GenRow {
  job_id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  user_plan: string | null;
  task_type: string | null;
  project_title: string | null;
  output_summary: string | null;
  cost: number | null;
  status: string | null;
  created_at: string;
  finished_at: string | null;
  error_message: string | null;
  payload: unknown;
}

interface DeadLetterRow {
  id: string;
  task_type: string;
  user_id: string | null;
  attempts: number;
  error_message: string | null;
  failed_at: string;
  source_job_id: string;
  payload: unknown;
}

const STATUSES = ["all", "pending", "processing", "completed", "failed", "cancelled"] as const;
type StatusFilter = (typeof STATUSES)[number];

function parseStatus(raw: string | null): StatusFilter {
  return STATUSES.includes((raw ?? "all") as StatusFilter) ? ((raw ?? "all") as StatusFilter) : "all";
}

async function fetchKpis(): Promise<GenKpis> {
  const { data, error } = await rpc<GenKpis>("admin_generations_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_generations_kpis returned no data");
  return data;
}

async function fetchList(q: string, status: StatusFilter): Promise<GenRow[]> {
  const { data, error } = await rpc<GenRow[]>("admin_generations_list", {
    p_search: q.length >= 2 ? q : null,
    p_status: status === "all" ? null : status,
    p_type: null,
    p_since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    p_limit: 50,
    p_page: 1,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function fetchDeadLetter(): Promise<DeadLetterRow[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("dead_letter_jobs")
    .select("id, task_type, user_id, attempts, error_message, failed_at, source_job_id, payload")
    .gte("failed_at", since)
    .order("failed_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeadLetterRow[];
}

function statusPill(s: string | null): { variant: "ok" | "err" | "warn"; label: string } {
  if (s === "completed") return { variant: "ok", label: "Done" };
  if (s === "failed" || s === "cancelled") return { variant: "err", label: s === "cancelled" ? "Cancelled" : "Failed" };
  return { variant: "warn", label: s ? s.charAt(0).toUpperCase() + s.slice(1) : "Queued" };
}

export function TabGenerations(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const status = parseStatus(searchParams.get("gstatus"));
  const selectedId = searchParams.get("job");
  const [forceOpen, setForceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const setParam = (key: string, value: string | null): void => {
    const params = new URLSearchParams(searchParams);
    if (value === null || value === "") params.delete(key); else params.set(key, value);
    setSearchParams(params, { replace: true });
  };

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("gens", "kpis"),
    queryFn: fetchKpis,
  });
  const list = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("gens", "list", q, status),
    queryFn: () => fetchList(q, status),
  });
  const dlq = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("gens", "dlq"),
    queryFn: fetchDeadLetter,
  });

  // Realtime: refresh on any video_generation_jobs change.
  useEffect(() => {
    const channel = supabase
      .channel("admin-tab-gens:video_generation_jobs")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "video_generation_jobs" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

  useEffect(() => {
    if (kpis.error) toast.error("Generations KPIs failed", { id: "g-kpi" });
    if (list.error) toast.error("Generations list failed", { id: "g-list" });
    if (dlq.error) toast.error("Dead-letter load failed", { id: "g-dlq" });
  }, [kpis.error, list.error, dlq.error]);

  const k = kpis.data;
  const dash = "—";
  const rows = list.data ?? [];
  const selected = rows.find((r) => r.job_id === selectedId);

  async function retry(): Promise<void> {
    if (!selected) return;
    try {
      const { error } = await rpc<unknown>("admin_retry_generation", { p_job_id: selected.job_id });
      if (error) throw new Error(error.message);
      toast.success("Retry queued");
      queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    }
  }

  async function cancelRefund(): Promise<void> {
    if (!selected) return;
    const { error } = await rpc<unknown>("admin_cancel_job_with_refund", {
      p_job_id: selected.job_id, p_reason: "admin cancel",
    });
    if (error) throw new Error(error.message);
    queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
  }

  async function forceComplete(): Promise<void> {
    if (!selected) return;
    const { error } = await rpc<unknown>("admin_force_complete_job", {
      p_job_id: selected.job_id, p_result: { forced: true }, p_reason: "admin force complete",
    });
    if (error) throw new Error(error.message);
    queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
  }

  async function requeueDlq(id: string): Promise<void> {
    try {
      const { error } = await rpc<unknown>("admin_requeue_dead_letter", { p_dlq_id: id });
      if (error) throw new Error(error.message);
      toast.success("Re-queued");
      queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Requeue failed");
    }
  }

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Generations · today"
          value={k ? fmtNum(k.gens_today) : dash}
          delta={k && k.gens_yesterday ? `${(((k.gens_today - k.gens_yesterday) / k.gens_yesterday) * 100).toFixed(0)}% vs yest` : undefined}
          deltaDir={k && k.gens_today >= k.gens_yesterday ? "up" : "down"}
          spark={k?.spark_today} icon={<I.spark />} />
        <Kpi label="Success rate" sparkColor="#5CD68D"
          value={k ? k.success_rate_24h.toFixed(1) : dash} unit="%"
          delta={k ? `${(k.success_rate_24h - k.success_rate_prev).toFixed(1)} pts wk/wk` : undefined}
          deltaDir={k && k.success_rate_24h >= k.success_rate_prev ? "up" : "down"} />
        <Kpi label="Median time"
          value={k && k.median_time_s !== null ? Math.round(k.median_time_s).toString() : dash} unit="s"
          delta={k && k.median_time_s !== null && k.median_time_prev_s !== null
            ? `${Math.round(k.median_time_s - k.median_time_prev_s)}s wk/wk` : undefined}
          deltaDir={k && (k.median_time_s ?? 0) <= (k.median_time_prev_s ?? 0) ? "up" : "down"} />
        <Kpi label="In queue" tone="danger"
          value={k ? fmtNum(k.in_queue) : dash}
          delta={k ? `${k.over_sla} over SLA` : undefined}
          deltaDir={k && k.over_sla === 0 ? "up" : "down"} />
      </div>

      <SectionHeader title="By type · last 7 days" />
      <div className="cols-3">
        <div className="card"><AdminEmpty title="Cinematic — chart coming" hint="Wire admin_mv_daily_generation_stats." /></div>
        <div className="card"><AdminEmpty title="Explainer — chart coming" hint="Wire admin_mv_daily_generation_stats." /></div>
        <div className="card"><AdminEmpty title="Voice — chart coming" hint="Wire admin_mv_daily_generation_stats." /></div>
      </div>

      <SectionHeader
        title="Recent generations"
        right={
          <>
            <SearchRow value={q} onChange={(v) => setParam("q", v)}
              placeholder="Search by id, user, prompt…" minWidth={240} />
            <select value={status} onChange={(e) => setParam("gstatus", e.target.value === "all" ? null : e.target.value)}
              className="btn-ghost" style={{ padding: "6px 10px", background: "var(--panel-3)", color: "var(--ink)" }}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" className="btn-ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "gens"] })}>
              <I.refresh />
            </button>
          </>
        }
      />

      <div className="tbl-wrap">
        <div className="scroll" style={{ maxHeight: 560 }}>
          <table className="tbl">
            <thead><tr>
              <th>ID</th><th>User</th><th>Type</th><th>Project</th><th>Output</th>
              <th style={{ textAlign: "right" }}>Cost</th><th>Status</th><th>When</th>
              <th style={{ width: 80 }} />
            </tr></thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={9}><AdminLoading /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9}><AdminEmpty title="No generations match" /></td></tr>
              ) : rows.map((r) => {
                const sp = statusPill(r.status);
                return (
                  <tr key={r.job_id} style={{ background: selectedId === r.job_id ? "var(--cyan-dim)" : undefined }}>
                    <td className="mono" style={{ fontSize: 11 }}>{r.job_id.slice(0, 10)}</td>
                    <td>
                      <div className="meta">
                        <div className="n">{r.user_name ?? "—"}</div>
                        <div className="e">{r.user_plan ?? r.user_email ?? ""}</div>
                      </div>
                    </td>
                    <td className="strong">{r.task_type ?? "—"}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.project_title ?? "—"}</td>
                    <td>
                      {r.output_summary ?? "—"}
                      {r.error_message && <div className="mono" style={{ color: "var(--warn)", fontSize: 10.5, marginTop: 2 }}>{r.error_message.slice(0, 60)}</div>}
                    </td>
                    <td className="num strong" style={{ textAlign: "right" }}>{r.cost && r.cost > 0 ? money(r.cost) : "—"}</td>
                    <td><Pill variant={sp.variant} dot>{sp.label}</Pill></td>
                    <td className="mono">{formatRel(r.created_at)}</td>
                    <td>
                      <button type="button" className="btn-mini"
                        onClick={() => setParam("job", selectedId === r.job_id ? null : r.job_id)}>
                        {selectedId === r.job_id ? "Hide" : "View"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card" style={{ padding: 16, marginTop: 14 }}>
          <div className="card-h">
            <div className="t">Job · <span className="mono">{selected.job_id}</span></div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" className="btn-mini" onClick={retry}><I.refresh /> Retry</button>
              <button type="button" className="btn-mini danger" onClick={() => setCancelOpen(true)}><I.x /> Cancel + refund</button>
              <button type="button" className="btn-mini" onClick={() => setForceOpen(true)}><I.check /> Force complete</button>
            </div>
          </div>
          <pre style={{
            fontFamily: "var(--mono)", fontSize: 11, background: "var(--panel-3)",
            padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 280, color: "var(--ink-dim)",
          }}>
            {JSON.stringify({
              status: selected.status,
              task_type: selected.task_type,
              project_title: selected.project_title,
              created_at: selected.created_at,
              finished_at: selected.finished_at,
              cost: selected.cost,
              error: selected.error_message,
              payload: selected.payload,
            }, null, 2)}
          </pre>
        </div>
      )}

      <SectionHeader title="Dead-letter queue" />
      <div className="tbl-wrap">
        <div className="scroll" style={{ maxHeight: 360 }}>
          <table className="tbl">
            <thead><tr>
              <th>When</th><th>Task</th><th>User</th><th>Error</th>
              <th style={{ textAlign: "right" }}>Attempts</th><th style={{ width: 120 }} />
            </tr></thead>
            <tbody>
              {dlq.isLoading ? (
                <tr><td colSpan={6}><AdminLoading /></td></tr>
              ) : (dlq.data ?? []).length === 0 ? (
                <tr><td colSpan={6}><AdminEmpty title="Dead-letter queue is empty" /></td></tr>
              ) : (dlq.data ?? []).map((d) => (
                <tr key={d.id}>
                  <td className="mono">{formatRel(d.failed_at)}</td>
                  <td className="strong">{d.task_type}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{d.user_id ? d.user_id.slice(0, 8) : "—"}</td>
                  <td><span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}>{(d.error_message ?? "").slice(0, 80)}</span></td>
                  <td className="num" style={{ textAlign: "right" }}>{d.attempts}</td>
                  <td>
                    <button type="button" className="btn-mini" onClick={() => requeueDlq(d.id)}>
                      <I.refresh /> Requeue
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDestructive
        open={cancelOpen} onOpenChange={setCancelOpen}
        title="Cancel job + refund?"
        description="The job will be marked cancelled and credits refunded to the user. Audit-logged."
        confirmText="CANCEL" actionLabel="Cancel + refund"
        onConfirm={cancelRefund} successMessage="Job cancelled, credits refunded"
      />
      <ConfirmDestructive
        open={forceOpen} onOpenChange={setForceOpen}
        title="Force complete this job?"
        description="Marks the job as completed without running it. Use only for stuck jobs. Audit-logged."
        confirmText="FORCE" actionLabel="Force complete"
        onConfirm={forceComplete} successMessage="Job force-completed"
      />
    </div>
  );
}
