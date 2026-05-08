/**
 * GenerationDrilldown — Phase 9.5 inline detail panel for a selected
 * job in TabGenerations. Single round-trip via `admin_generation_detail`
 * returns the job row plus pipeline trace (system_logs), API calls
 * (api_call_logs), and the cost breakdown row (generation_costs).
 *
 * Sections rendered:
 *   1. Job info — id, status, type, project, timestamps, worker
 *   2. Pipeline trace — chronological system_logs scoped to this
 *      generation_id (or job_id when no gen_id is on the payload yet)
 *   3. API calls — provider/model/status/cost per upstream call
 *   4. Cost breakdown — per-provider columns from generation_costs
 *   5. Error stack — error_message + payload._stack when present
 *
 * Action buttons (Retry / Cancel + refund / Force complete) live on the
 * parent TabGenerations so they can drive its ConfirmDestructive state.
 */
import { useQuery } from "@tanstack/react-query";
import { type JSX, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { Pill } from "@/components/admin/_shared/Pill";
import { formatRel, money } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

interface JobRow {
  id: string;
  user_id: string | null;
  task_type: string | null;
  status: string | null;
  progress: number | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  payload: Record<string, unknown> | null;
}
interface PipelineEvent {
  created_at: string;
  category: string | null;
  event_type: string | null;
  message: string | null;
  details: Record<string, unknown> | null;
}
interface ApiCall {
  id: string;
  provider: string;
  model: string;
  status: string;
  queue_time_ms: number | null;
  running_time_ms: number | null;
  total_duration_ms: number | null;
  cost: number | null;
  error_message: string | null;
  created_at: string;
}
interface CostBreakdown {
  openrouter_cost: number | null;
  replicate_cost: number | null;
  hypereal_cost: number | null;
  google_tts_cost: number | null;
  total_cost: number | null;
}
interface DetailResp {
  job: JobRow;
  generation_id: string | null;
  pipeline_trace: PipelineEvent[];
  api_calls: ApiCall[];
  cost_breakdown: CostBreakdown | null;
}

async function fetchDetail(jobId: string): Promise<DetailResp> {
  const { data, error } = await rpc<DetailResp>("admin_generation_detail", { p_job_id: jobId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_generation_detail returned no data");
  return data;
}

function Section({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="card-h" style={{ marginBottom: 8 }}>
        <div className="t" style={{ fontSize: 12.5 }}>{title}</div>
        {badge}
      </div>
      {children}
    </div>
  );
}

function pillForApi(status: string): "ok" | "err" | "warn" {
  if (status === "succeeded" || status === "completed") return "ok";
  if (status === "failed") return "err";
  return "warn";
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface GenerationDrilldownProps {
  jobId: string;
  /** Slot for action buttons (Retry / Cancel / Force complete) so the
   *  parent owns the destructive-confirm state. */
  actions?: ReactNode;
}

export function GenerationDrilldown({ jobId, actions }: GenerationDrilldownProps): JSX.Element {
  const detail = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("gens", "detail", jobId),
    queryFn: () => fetchDetail(jobId),
  });

  if (detail.isLoading) {
    return <div className="card" style={{ padding: 16, marginTop: 14 }}><AdminLoading /></div>;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <AdminEmpty title="Failed to load drilldown"
          hint={detail.error instanceof Error ? detail.error.message : ""} />
      </div>
    );
  }

  const d = detail.data;
  const j = d.job;
  const stack = (j.payload && typeof j.payload === "object" && "_stack" in j.payload)
    ? String((j.payload as Record<string, unknown>)._stack ?? "")
    : "";

  return (
    <div style={{ marginTop: 14 }}>
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="card-h" style={{ marginBottom: 10 }}>
          <div className="t">
            Job · <span className="mono" style={{ fontSize: 11 }}>{j.id}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>{actions}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "10px 18px", fontSize: 12 }}>
          <KV label="Status" value={<Pill variant={j.status === "completed" ? "ok" : j.status === "failed" || j.status === "cancelled" ? "err" : "warn"} dot>{j.status ?? "—"}</Pill>} />
          <KV label="Type" value={<span className="strong">{j.task_type ?? "—"}</span>} />
          <KV label="Progress" value={<span className="mono">{j.progress ?? 0}%</span>} />
          <KV label="Worker" value={<span className="mono" style={{ fontSize: 11 }}>{j.worker_id ? j.worker_id.slice(0, 12) : "—"}</span>} />
          <KV label="Created" value={<span className="mono">{formatRel(j.created_at)}</span>} />
          <KV label="Started" value={<span className="mono">{j.started_at ? formatRel(j.started_at) : "—"}</span>} />
          <KV label="Finished" value={<span className="mono">{j.finished_at ? formatRel(j.finished_at) : "—"}</span>} />
          <KV label="Generation" value={<span className="mono" style={{ fontSize: 11 }}>{d.generation_id ? d.generation_id.slice(0, 8) : "—"}</span>} />
        </div>
      </div>

      <Section title="Pipeline trace" badge={<span className="lbl">{d.pipeline_trace.length}</span>}>
        {d.pipeline_trace.length === 0 ? (
          <AdminEmpty title="No log events for this job" />
        ) : (
          <div style={{ maxHeight: 220, overflowY: "auto", fontSize: 11.5 }}>
            {d.pipeline_trace.map((ev, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "120px 130px 1fr", gap: 10, padding: "5px 0", borderBottom: "1px dashed var(--line)" }}>
                <span className="mono" style={{ color: "var(--ink-dim)" }}>{formatRel(ev.created_at)}</span>
                <span className="mono" style={{ color: ev.category === "system_error" ? "var(--warn)" : "var(--cyan)" }}>{ev.event_type ?? ev.category ?? "—"}</span>
                <span style={{ color: "var(--ink)" }}>{ev.message ?? "(no message)"}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="API calls" badge={<span className="lbl">{d.api_calls.length}</span>}>
        {d.api_calls.length === 0 ? (
          <AdminEmpty title="No API calls recorded" hint="Worker may not log api_call_logs for this task type." />
        ) : (
          <table className="tbl" style={{ fontSize: 11.5 }}>
            <thead><tr>
              <th>When</th><th>Provider</th><th>Model</th>
              <th style={{ textAlign: "right" }}>Duration</th>
              <th style={{ textAlign: "right" }}>Cost</th>
              <th>Status</th>
            </tr></thead>
            <tbody>
              {d.api_calls.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{formatRel(c.created_at)}</td>
                  <td className="strong">{c.provider}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{c.model}</td>
                  <td className="num" style={{ textAlign: "right" }}>{fmtDuration(c.total_duration_ms)}</td>
                  <td className="num strong" style={{ textAlign: "right" }}>{c.cost && c.cost > 0 ? money(c.cost) : "—"}</td>
                  <td><Pill variant={pillForApi(c.status)} dot>{c.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Cost breakdown">
        {!d.cost_breakdown ? (
          <AdminEmpty title="No cost data for this generation" />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, fontSize: 12 }}>
            <KV label="OpenRouter" value={<span className="num strong">{money(d.cost_breakdown.openrouter_cost ?? 0)}</span>} />
            <KV label="Replicate" value={<span className="num strong">{money(d.cost_breakdown.replicate_cost ?? 0)}</span>} />
            <KV label="Hypereal" value={<span className="num strong">{money(d.cost_breakdown.hypereal_cost ?? 0)}</span>} />
            <KV label="Google TTS" value={<span className="num strong">{money(d.cost_breakdown.google_tts_cost ?? 0)}</span>} />
            <KV label="Total" value={<span className="num strong" style={{ color: "var(--cyan)" }}>{money(d.cost_breakdown.total_cost ?? 0)}</span>} />
          </div>
        )}
      </Section>

      {(j.error_message || stack) && (
        <Section title="Error">
          {j.error_message && (
            <div style={{ fontSize: 12, color: "var(--warn)", marginBottom: 6, fontFamily: "var(--mono)" }}>
              {j.error_message}
            </div>
          )}
          {stack && (
            <pre style={{
              fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--panel-3)",
              padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 180, color: "var(--ink-dim)",
            }}>{stack}</pre>
          )}
        </Section>
      )}

      <Section title="Payload">
        <pre style={{
          fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--panel-3)",
          padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 220, color: "var(--ink-dim)",
        }}>{JSON.stringify(j.payload, null, 2)}</pre>
      </Section>
    </div>
  );
}

function KV({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-mute)", marginBottom: 2 }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}
