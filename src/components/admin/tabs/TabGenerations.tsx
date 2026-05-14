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

import { useEffect, useMemo, useState, type JSX } from "react";
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
import { GenerationDrilldown } from "@/components/admin/generations/GenerationDrilldown";

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

interface GenKpis {
  gens_today: number | null; gens_yesterday: number | null;
  success_rate_24h: number | null; success_rate_prev: number | null;
  median_time_s: number | null; median_time_prev_s: number | null;
  in_queue: number | null; over_sla: number | null;
  spark_today: number[] | null;
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

const TASK_TYPES = ["all", "generate_video", "generate_cinematic", "cinematic_video", "cinematic_audio", "cinematic_image", "finalize_generation", "regenerate_image", "regenerate_audio", "export_video", "autopost_run"] as const;
type TaskFilter = (typeof TASK_TYPES)[number];

const RANGES = ["24h", "7d", "30d"] as const;
type RangeFilter = (typeof RANGES)[number];
const RANGE_HOURS: Record<RangeFilter, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

function parseStatus(raw: string | null): StatusFilter {
  return STATUSES.includes((raw ?? "all") as StatusFilter) ? ((raw ?? "all") as StatusFilter) : "all";
}
function parseTask(raw: string | null): TaskFilter {
  return TASK_TYPES.includes((raw ?? "all") as TaskFilter) ? ((raw ?? "all") as TaskFilter) : "all";
}
function parseRange(raw: string | null): RangeFilter {
  return RANGES.includes((raw ?? "7d") as RangeFilter) ? ((raw ?? "7d") as RangeFilter) : "7d";
}

async function fetchKpis(): Promise<GenKpis> {
  const { data, error } = await rpc<GenKpis>("admin_generations_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_generations_kpis returned no data");
  return data;
}

async function fetchList(q: string, status: StatusFilter, type: TaskFilter, range: RangeFilter): Promise<GenRow[]> {
  const sinceMs = Date.now() - RANGE_HOURS[range] * 60 * 60 * 1000;
  const { data, error } = await rpc<GenRow[]>("admin_generations_list", {
    p_search: q.length >= 2 ? q : null,
    p_status: status === "all" ? null : status,
    p_type: type === "all" ? null : type,
    p_since: new Date(sinceMs).toISOString(),
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
  const type = parseTask(searchParams.get("gtype"));
  const range = parseRange(searchParams.get("grange"));
  const workerFilter = searchParams.get("gworker") ?? "";
  const selectedId = searchParams.get("job");
  const [forceOpen, setForceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dlqInspect, setDlqInspect] = useState<DeadLetterRow | null>(null);

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
    queryKey: adminKey("gens", "list", q, status, type, range),
    queryFn: () => fetchList(q, status, type, range),
  });
  const dlq = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("gens", "dlq"),
    queryFn: fetchDeadLetter,
  });

  // Realtime: refresh on any video_generation_jobs change. We keep
  // event:* here (unlike useAdminLiveCounters which narrows to active
  // statuses) because this tab's KPIs include terminal-state counters
  // (completed today, failed today). Debounced @ 500ms so a burst of
  // events during a multi-scene generation triggers one refetch
  // instead of N — added 2026-05-14 alongside the publication shrink.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedInvalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["admin", "gens"] });
        timer = null;
      }, 500);
    };
    const channel = supabase
      .channel("admin-tab-gens:video_generation_jobs")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "video_generation_jobs" },
        debouncedInvalidate,
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  useEffect(() => {
    if (kpis.error) toast.error("Generations KPIs failed", { id: "g-kpi" });
    if (list.error) toast.error("Generations list failed", { id: "g-list" });
    if (dlq.error) toast.error("Dead-letter load failed", { id: "g-dlq" });
  }, [kpis.error, list.error, dlq.error]);

  const k = kpis.data;
  const dash = "—";
  const rawRows = list.data ?? [];
  // Worker-id is filtered client-side rather than via RPC param to keep
  // the SECURITY DEFINER signature stable (Phase 9.4 — admins typing a
  // worker prefix gets near-instant filtering on the already-loaded set).
  const rows = useMemo(() => {
    if (!workerFilter.trim()) return rawRows;
    const needle = workerFilter.trim().toLowerCase();
    return rawRows.filter((r) => (((r as unknown as { worker_id?: string }).worker_id ?? "").toLowerCase().includes(needle)));
  }, [rawRows, workerFilter]);
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
          value={k && k.gens_today != null ? fmtNum(k.gens_today) : dash}
          delta={k && k.gens_yesterday ? `${(((k.gens_today - k.gens_yesterday) / k.gens_yesterday) * 100).toFixed(0)}% vs yest` : undefined}
          deltaDir={k && (k.gens_today ?? 0) >= (k.gens_yesterday ?? 0) ? "up" : "down"}
          spark={k?.spark_today} icon={<I.spark />} />
        <Kpi label="Success rate" sparkColor="#14C8CC"
          value={k && k.success_rate_24h != null ? k.success_rate_24h.toFixed(1) : dash} unit="%"
          delta={k && k.success_rate_24h != null && k.success_rate_prev != null
            ? `${(k.success_rate_24h - k.success_rate_prev).toFixed(1)} pts wk/wk`
            : undefined}
          deltaDir={k && (k.success_rate_24h ?? 0) >= (k.success_rate_prev ?? 0) ? "up" : "down"} />
        <Kpi label="Median time"
          value={k && k.median_time_s != null ? Math.round(k.median_time_s).toString() : dash} unit="s"
          delta={k && k.median_time_s != null && k.median_time_prev_s != null
            ? `${Math.round(k.median_time_s - k.median_time_prev_s)}s wk/wk` : undefined}
          deltaDir={k && (k.median_time_s ?? 0) <= (k.median_time_prev_s ?? 0) ? "up" : "down"} />
        <Kpi label="In queue" tone="danger"
          value={k && k.in_queue != null ? fmtNum(k.in_queue) : dash}
          delta={k && k.over_sla != null ? `${k.over_sla} over SLA` : undefined}
          deltaDir={k && (k.over_sla ?? 0) === 0 ? "up" : "down"} />
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
            <button type="button" className={"btn-ghost" + (filtersOpen ? " active" : "")}
              onClick={() => setFiltersOpen((v) => !v)}>
              <I.filter /> Filters
              {(status !== "all" || type !== "all" || range !== "7d" || workerFilter) && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--cyan-dim)", color: "var(--cyan)", fontSize: 10 }}>
                  {[status !== "all", type !== "all", range !== "7d", !!workerFilter].filter(Boolean).length}
                </span>
              )}
            </button>
            <button type="button" className="btn-ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "gens"] })}>
              <I.refresh />
            </button>
          </>
        }
      />

      {filtersOpen && (
        <div className="card" style={{ padding: 12, marginBottom: 12, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <FilterDropdown label="Status" value={status} options={STATUSES as readonly string[]}
            onChange={(v) => setParam("gstatus", v === "all" ? null : v)} />
          <FilterDropdown label="Task type" value={type} options={TASK_TYPES as readonly string[]}
            onChange={(v) => setParam("gtype", v === "all" ? null : v)} />
          <FilterDropdown label="Range" value={range} options={RANGES as readonly string[]}
            onChange={(v) => setParam("grange", v === "7d" ? null : v)} />
          <div>
            <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 4 }}>Worker id</div>
            <input type="text" value={workerFilter}
              onChange={(e) => setParam("gworker", e.target.value)}
              placeholder="prefix or full id"
              aria-label="Filter generations by worker ID"
              className="mono"
              style={{ width: "100%", padding: 6, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 4, fontSize: 11.5 }} />
          </div>
        </div>
      )}

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
        <GenerationDrilldown
          jobId={selected.job_id}
          actions={(
            <>
              <button type="button" className="btn-mini" onClick={retry}><I.refresh /> Retry</button>
              <button type="button" className="btn-mini danger" onClick={() => setCancelOpen(true)}><I.x /> Cancel + refund</button>
              <button type="button" className="btn-mini" onClick={() => setForceOpen(true)}><I.check /> Force complete</button>
              <button type="button" className="btn-mini" onClick={() => setParam("job", null)}>Close</button>
            </>
          )}
        />
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
                  <td style={{ display: "flex", gap: 4 }}>
                    <button type="button" className="btn-mini" onClick={() => setDlqInspect(d)} title="Inspect">
                      <I.search /> Inspect
                    </button>
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

      {dlqInspect && (
        <DlqInspectModal row={dlqInspect} onClose={() => setDlqInspect(null)} />
      )}
    </div>
  );
}

function FilterDropdown({
  label, value, options, onChange,
}: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 4 }}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", padding: 6, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 4, fontSize: 12 }}>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </div>
  );
}

function DlqInspectModal({ row, onClose }: { row: DeadLetterRow; onClose: () => void }): JSX.Element {
  return (
    <div role="dialog" aria-modal="true"
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={onClose}
        style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.55)", backdropFilter: "blur(2px)" }} />
      <div className="card" style={{
        position: "relative", width: 720, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 64px)",
        display: "flex", flexDirection: "column", padding: 16,
      }}>
        <div className="card-h" style={{ marginBottom: 12 }}>
          <div className="t">Dead-letter · <span className="mono" style={{ fontSize: 11 }}>{row.id}</span></div>
          <button type="button" className="btn-mini" onClick={onClose}><I.x /></button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, fontSize: 12, marginBottom: 12 }}>
          <div><div className="lbl">Task</div><div className="strong">{row.task_type}</div></div>
          <div><div className="lbl">Attempts</div><div className="num strong">{row.attempts}</div></div>
          <div><div className="lbl">User</div><div className="mono" style={{ fontSize: 11 }}>{row.user_id ? row.user_id.slice(0, 8) : "—"}</div></div>
          <div><div className="lbl">When</div><div className="mono">{formatRel(row.failed_at)}</div></div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <div className="lbl" style={{ fontSize: 9.5, marginBottom: 4 }}>Error</div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--warn)", padding: 8, background: "var(--panel-3)", borderRadius: 4 }}>
            {row.error_message ?? "(no message)"}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          <div className="lbl" style={{ fontSize: 9.5, marginBottom: 4 }}>Original payload</div>
          <pre style={{
            fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--panel-3)",
            padding: 8, borderRadius: 4, overflow: "auto", color: "var(--ink-dim)", margin: 0,
          }}>{JSON.stringify(row.payload, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
