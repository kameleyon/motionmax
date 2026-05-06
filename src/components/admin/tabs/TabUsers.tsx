/**
 * TabUsers — Phase 8 admin Users tab. Wires the four new RPCs landed in
 * Phase 8.1: `admin_users_kpis()`, `admin_users_list(...)`,
 * `admin_bulk_grant_credits(...)`, `admin_bulk_suspend(...)`. Selecting a
 * row opens `<UserDrawer>` lazy-loaded in this same module to keep the
 * drawer out of the initial admin chunk.
 *
 * URL state: `?q=&plan=&status=&page=&user=<uuid>`. The `user` param drives
 * the drawer so a deep-linked admin URL re-opens the same user. Filters
 * use the existing chip-button pattern (mirrors TabApi / TabActivity).
 *
 * Bulk action bar: appears only when ≥1 row is selected. Both actions
 * gate behind `<ConfirmDestructive>` (typed-confirm "BULK") to avoid
 * fat-fingered mass-mutations.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { Avatar } from "@/components/admin/_shared/Avatar";
import { ConfirmDestructive } from "@/components/admin/_shared/confirmDestructive";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { Pill } from "@/components/admin/_shared/Pill";
import { SearchRow } from "@/components/admin/_shared/SearchRow";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { formatRel, money, num as fmtNum, short } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

const UserDrawer = lazy(() =>
  import("@/components/admin/users/UserDrawer").then((m) => ({ default: m.UserDrawer })),
);

/** Cast `supabase.rpc` once — new RPCs land in generated types in a
 *  follow-up; the typed shim keeps callers free of `any`. */
type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

interface UsersKpis {
  total_users: number;
  paying: number;
  studio_plan: number;
  flagged: number;
  conversion_pct: number | null;
  paying_delta_wk: number | null;
  studio_delta_wk: number | null;
  flagged_auto: number | null;
  flagged_manual: number | null;
  total_users_spark: number[] | null;
}

interface UserRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  plan: string | null;
  status: string | null;
  last_sign_in_at: string | null;
  generations_count: number;
  lifetime_spent: number;
  credits: number;
  errors_24h: number;
  location: string | null;
  total_count: number;
}

type PlanFilter = "All" | "Studio" | "Pro" | "Free";
type StatusFilter = "All" | "active" | "flagged" | "paused";
const PLANS: PlanFilter[] = ["All", "Studio", "Pro", "Free"];
const STATUSES: StatusFilter[] = ["All", "active", "flagged", "paused"];
const PAGE_SIZE = 50;

function parsePlan(raw: string | null): PlanFilter {
  return PLANS.includes((raw ?? "All") as PlanFilter) ? ((raw ?? "All") as PlanFilter) : "All";
}
function parseStatus(raw: string | null): StatusFilter {
  return STATUSES.includes((raw ?? "All") as StatusFilter) ? ((raw ?? "All") as StatusFilter) : "All";
}
function parsePage(raw: string | null): number {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function fetchKpis(): Promise<UsersKpis> {
  const { data, error } = await rpc<UsersKpis>("admin_users_kpis");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_users_kpis returned no data");
  return data;
}

async function fetchList(
  q: string,
  plan: PlanFilter,
  status: StatusFilter,
  page: number,
): Promise<UserRow[]> {
  const { data, error } = await rpc<UserRow[]>("admin_users_list", {
    p_search: q.length >= 2 ? q : null,
    p_plan: plan === "All" ? null : plan,
    p_status: status === "All" ? null : status,
    p_flag_state: null,
    p_page: page,
    p_limit: PAGE_SIZE,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function planVariant(plan: string | null): "cyan" | "purple" | "default" {
  if (plan === "Studio") return "cyan";
  if (plan === "Pro") return "purple";
  return "default";
}
function statusVariant(s: string | null): "ok" | "warn" | "err" {
  if (s === "active") return "ok";
  if (s === "paused") return "warn";
  return "err";
}
function errorsColor(n: number): string {
  if (n > 3) return "var(--warn)";
  if (n > 0) return "#F5B049";
  return "var(--ink-dim)";
}

function exportCsv(rows: UserRow[]): void {
  const header = ["id", "name", "email", "plan", "status", "last_sign_in", "generations", "spent", "credits", "errors", "location"];
  const lines = rows.map((r) => [
    r.user_id, r.display_name ?? "", r.email ?? "", r.plan ?? "", r.status ?? "",
    r.last_sign_in_at ?? "", r.generations_count, r.lifetime_spent, r.credits, r.errors_24h, r.location ?? "",
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `users-${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

export function TabUsers(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const plan = parsePlan(searchParams.get("plan"));
  const status = parseStatus(searchParams.get("status"));
  const page = parsePage(searchParams.get("page"));
  const userId = searchParams.get("user");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCreditsOpen, setBulkCreditsOpen] = useState(false);
  const [bulkSuspendOpen, setBulkSuspendOpen] = useState(false);
  const [bulkAmount, setBulkAmount] = useState("100");
  const [bulkReason, setBulkReason] = useState("");

  const setParam = (key: string, value: string | null): void => {
    const params = new URLSearchParams(searchParams);
    if (value === null || value === "") params.delete(key); else params.set(key, value);
    if (key !== "page") params.delete("page");
    setSearchParams(params, { replace: true });
  };

  const kpis = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("users", "kpis"),
    queryFn: fetchKpis,
  });
  const list = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("users", "list", q, plan, status, page),
    queryFn: () => fetchList(q, plan, status, page),
  });

  useEffect(() => {
    if (kpis.error) toast.error("Users KPIs failed", { id: "u-kpi" });
    if (list.error) toast.error("Users list failed", { id: "u-list" });
  }, [kpis.error, list.error]);

  const rows = list.data ?? [];
  const totalCount = rows[0]?.total_count ?? 0;
  const dash = "—";
  const k = kpis.data;
  const start = (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(start + rows.length - 1, start + PAGE_SIZE - 1);

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.user_id));
  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) rows.forEach((r) => next.delete(r.user_id));
      else rows.forEach((r) => next.add(r.user_id));
      return next;
    });
  };
  const toggleOne = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const invalidateUsers = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  async function runBulkCredits(): Promise<void> {
    const amt = Number.parseInt(bulkAmount, 10);
    if (!Number.isFinite(amt) || amt === 0) throw new Error("Enter a non-zero amount");
    const { error } = await rpc<unknown>("admin_bulk_grant_credits", {
      p_user_ids: selectedIds, p_amount: amt, p_reason: bulkReason || "bulk grant",
    });
    if (error) throw new Error(error.message);
    setSelected(new Set()); setBulkAmount("100"); setBulkReason("");
    invalidateUsers();
  }
  async function runBulkSuspend(): Promise<void> {
    const { error } = await rpc<unknown>("admin_bulk_suspend", {
      p_user_ids: selectedIds, p_reason: bulkReason || "bulk suspend",
    });
    if (error) throw new Error(error.message);
    setSelected(new Set()); setBulkReason("");
    invalidateUsers();
  }

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Total users" icon={<I.users />}
          value={k ? short(k.total_users) : dash}
          delta={k && k.total_users_spark ? `${fmtNum(k.total_users)} total` : undefined}
          deltaDir="up" spark={k?.total_users_spark ?? undefined} />
        <Kpi label="Paying" sparkColor="#5CD68D"
          value={k ? fmtNum(k.paying) : dash}
          delta={k && k.conversion_pct !== null ? `${k.conversion_pct.toFixed(1)}% conversion` : undefined}
          deltaDir="up" />
        <Kpi label="Studio plan"
          value={k ? fmtNum(k.studio_plan) : dash}
          delta={k && k.studio_delta_wk !== null ? `${k.studio_delta_wk >= 0 ? "+" : ""}${k.studio_delta_wk} wk` : undefined}
          deltaDir={k && (k.studio_delta_wk ?? 0) >= 0 ? "up" : "down"} />
        <Kpi label="Flagged" tone="danger" icon={<I.flag />}
          value={k ? fmtNum(k.flagged) : dash}
          delta={k ? `${k.flagged_auto ?? 0} auto · ${k.flagged_manual ?? 0} manual` : undefined}
          deltaDir="down" />
      </div>

      <SectionHeader
        title="Directory"
        right={
          <>
            <SearchRow value={q} onChange={(v) => setParam("q", v)}
              placeholder="Search name, email, user_id…" minWidth={280} />
            <div style={{ display: "flex", gap: 6 }}>
              {PLANS.map((p) => (
                <button key={p} type="button" onClick={() => setParam("plan", p === "All" ? null : p)}
                  className={"btn-mini" + (plan === p ? " active" : "")}
                  style={plan === p ? { color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)", background: "var(--cyan-dim)" } : undefined}>
                  {p}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {STATUSES.map((s) => (
                <button key={s} type="button" onClick={() => setParam("status", s === "All" ? null : s)}
                  className={"btn-mini" + (status === s ? " active" : "")}
                  style={status === s ? { color: "var(--cyan)", borderColor: "rgba(20,200,204,.3)", background: "var(--cyan-dim)" } : undefined}>
                  {s}
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost" onClick={() => exportCsv(rows)}>
              <I.download /> Export
            </button>
          </>
        }
      />

      {selected.size > 0 && (
        <div className="card" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
          <span className="mono" style={{ fontSize: 12, color: "var(--ink)" }}>
            {selected.size} selected
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn-mini" onClick={() => setBulkCreditsOpen(true)}>
            <I.credit /> Grant credits
          </button>
          <button type="button" className="btn-mini danger" onClick={() => setBulkSuspendOpen(true)}>
            <I.pause /> Suspend
          </button>
          <button type="button" className="btn-mini" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="tbl-wrap">
        <div className="scroll" style={{ maxHeight: 600 }}>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>User</th><th>Plan</th><th>Status</th>
              <th>Last sign-in</th>
              <th style={{ textAlign: "right" }}>Generations</th>
              <th style={{ textAlign: "right" }}>Lifetime spent</th>
              <th style={{ textAlign: "right" }}>Credits</th>
              <th style={{ textAlign: "right" }}>Errors</th>
              <th>Location</th>
              <th style={{ width: 120 }} />
            </tr></thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={11}><AdminLoading /></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={11}><AdminEmpty title="No matching users" hint="Try widening the filters." /></td></tr>
              ) : rows.map((u) => (
                <tr key={u.user_id} onClick={() => setParam("user", u.user_id)} style={{ cursor: "pointer" }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(u.user_id)}
                      onChange={() => toggleOne(u.user_id)} aria-label={`Select ${u.display_name ?? u.user_id}`} />
                  </td>
                  <td>
                    <div className="av-row">
                      <Avatar user={{ name: u.display_name ?? "Unknown", avatar: u.avatar_url ?? undefined }} />
                      <div className="meta">
                        <div className="n" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {u.display_name ?? "Unknown"}
                        </div>
                        <div className="e">{u.email ?? ""}</div>
                      </div>
                    </div>
                  </td>
                  <td><Pill variant={planVariant(u.plan)}>{u.plan ?? "Free"}</Pill></td>
                  <td><Pill variant={statusVariant(u.status)} dot>{u.status ?? "active"}</Pill></td>
                  <td className="mono">{u.last_sign_in_at ? formatRel(u.last_sign_in_at) : "—"}</td>
                  <td className="num strong" style={{ textAlign: "right" }}>{fmtNum(u.generations_count)}</td>
                  <td className="num strong" style={{ textAlign: "right" }}>{money(u.lifetime_spent)}</td>
                  <td className="num" style={{ textAlign: "right" }}>{short(u.credits)}</td>
                  <td className="num" style={{ textAlign: "right", color: errorsColor(u.errors_24h) }}>{u.errors_24h}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{u.location ?? "—"}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button type="button" className="btn-mini" title="Message"
                        onClick={() => setParam("user", u.user_id)}><I.mail /></button>
                      <button type="button" className="btn-mini" title="Credits"
                        onClick={() => setParam("user", u.user_id)}><I.credit /></button>
                      <button type="button" className="btn-mini" title="More"
                        onClick={() => setParam("user", u.user_id)}><I.more /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 4px", color: "var(--ink-dim)", fontSize: 12 }}>
        <span className="mono">
          {totalCount > 0 ? `Showing ${start}–${end} of ${fmtNum(totalCount)}` : ""}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-mini" disabled={page <= 1}
            onClick={() => setParam("page", String(page - 1))}>Prev</button>
          <span className="mono" style={{ alignSelf: "center", fontSize: 11 }}>page {page}</span>
          <button type="button" className="btn-mini" disabled={end >= totalCount}
            onClick={() => setParam("page", String(page + 1))}>Next</button>
        </div>
      </div>

      <ConfirmDestructive
        open={bulkCreditsOpen}
        onOpenChange={setBulkCreditsOpen}
        title={`Grant credits to ${selected.size} users`}
        description={
          <div className="space-y-2">
            <div>Apply a credit adjustment to every selected user. Use a negative value to debit.</div>
            <input type="number" value={bulkAmount} onChange={(e) => setBulkAmount(e.target.value)}
              placeholder="Amount" className="font-mono" style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
            <input type="text" value={bulkReason} onChange={(e) => setBulkReason(e.target.value)}
              placeholder="Reason (audit log)" style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          </div>
        }
        confirmText="BULK"
        actionLabel="Grant"
        onConfirm={runBulkCredits}
        successMessage="Credits granted"
      />
      <ConfirmDestructive
        open={bulkSuspendOpen}
        onOpenChange={setBulkSuspendOpen}
        title={`Suspend ${selected.size} users`}
        description={
          <div className="space-y-2">
            <div>Each selected user will be paused. They can be reactivated from the user drawer.</div>
            <input type="text" value={bulkReason} onChange={(e) => setBulkReason(e.target.value)}
              placeholder="Reason (audit log)" style={{ width: "100%", padding: 8, background: "var(--panel-3)", border: "1px solid var(--line)", color: "var(--ink)", borderRadius: 6 }} />
          </div>
        }
        confirmText="BULK"
        actionLabel="Suspend"
        onConfirm={runBulkSuspend}
        successMessage="Users suspended"
      />

      {userId && (
        <Suspense fallback={null}>
          <UserDrawer userId={userId} onClose={() => setParam("user", null)} />
        </Suspense>
      )}
    </div>
  );
}
