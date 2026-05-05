/**
 * TabOverview — Phase 3 admin Overview tab. Wires `admin_overview_snapshot`,
 * `admin_overview_cost_split`, `admin_top_users_by_spend`, and
 * `admin_activity_feed` into the design's KPI grid + cols-2-1 body. Realtime
 * subscription on `system_logs` invalidates the activity feed.
 *
 * The "MRR" tile is rendered as "Credits sold · MTD" — real Stripe MRR is
 * gathered via an edge fn deferred to Phase 4.
 */

import { useEffect, type JSX } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ActivityFeed, type FeedItem, type FeedTone, type IconKey } from "@/components/admin/_shared/ActivityFeed";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { Avatar } from "@/components/admin/_shared/Avatar";
import { BarTrack } from "@/components/admin/_shared/BarTrack";
import { Donut, type DonutSlice } from "@/components/admin/_shared/Donut";
import { I } from "@/components/admin/_shared/AdminIcons";
import { Kpi } from "@/components/admin/_shared/Kpi";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { money, num as fmtNum, short } from "@/components/admin/_shared/format";
import { ADMIN_DEFAULT_QUERY_OPTIONS, adminKey } from "@/components/admin/_shared/queries";

type ActivityFilter = "live" | "all" | "generations" | "billing";
const FILTERS: { key: ActivityFilter; label: string; icon?: IconKey }[] = [
  { key: "live", label: "Live", icon: "bolt" },
  { key: "all", label: "All" },
  { key: "generations", label: "Generations" },
  { key: "billing", label: "Billing" },
];
function parseFilter(raw: string | null): ActivityFilter {
  return raw === "all" || raw === "generations" || raw === "billing" ? raw : "live";
}

interface OverviewSnapshot {
  active_users_24h: number; active_users_yesterday: number; active_users_spark: number[];
  gens_today: number; gens_yesterday: number; gens_spark: number[];
  mtd_spend: number; mtd_spend_spark: number[]; mtd_credits_sold: number;
  errors_1h: number; errors_24h_peak: number; open_tickets: number;
}
interface CostSplitRow { provider: string; spend: number; calls: number }
interface TopUserRow {
  user_id: string; display_name: string | null; avatar_url: string | null;
  spend: number; call_count: number;
}
interface ActivityFeedRow {
  created_at: string; event_type: string | null; category: string | null;
  user_id: string | null; message: string | null; details: unknown;
  generation_id: string | null; project_id: string | null;
}

/** Cast `supabase.rpc` once — the new RPCs land in generated types in a
 *  follow-up; the typed shim keeps callers free of `any`. */
type RpcFn = <T>(
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: T | null; error: { message: string } | null }>;
const rpc = (supabase.rpc as unknown) as RpcFn;

const GEN_EVENT_TYPES: readonly string[] = [
  "gen.started", "gen.completed", "gen.failed", "gen.queued",
  "gen.scene.completed", "gen.scene.failed",
];
const PAY_EVENT_TYPES: readonly string[] = [
  "pay.purchase", "pay.refund", "pay.subscription_grant",
  "pay.subscription_renewed", "pay.subscription_cancelled",
];
function eventTypesFor(f: ActivityFilter): string[] | null {
  if (f === "generations") return [...GEN_EVENT_TYPES];
  if (f === "billing") return [...PAY_EVENT_TYPES];
  return null;
}

function toneFor(e: string | null): FeedTone {
  if (!e) return "default";
  if (e.endsWith(".failed")) return "err";
  if (e.endsWith(".completed")) return "ok";
  if (e.startsWith("pay.") || e.startsWith("message.")) return "cyan";
  if (e.startsWith("kill.")) return "err";
  if (e.startsWith("flag.")) return "warn";
  return "default";
}
function glyphFor(e: string | null): IconKey {
  if (!e) return "spark";
  if (e.startsWith("pay.")) return "credit";
  if (e.endsWith(".failed")) return "alert";
  if (e.startsWith("auth.") || e.startsWith("admin.")) return "shield";
  if (e.startsWith("message.")) return "mail";
  if (e.startsWith("kill.")) return "power";
  if (e.startsWith("newsletter.")) return "send";
  if (e.startsWith("flag.")) return "flag";
  return "spark";
}

const PROVIDER_COLOR: Record<string, string> = {
  "Replicate · Video": "#14C8CC",
  "ElevenLabs": "#a78bfa",
  "Replicate · Image": "#F5B049",
  "OpenAI": "#5CD68D",
  "Other": "#5A6268",
};
const PROVIDER_ORDER: readonly string[] = [
  "Replicate · Video", "ElevenLabs", "Replicate · Image", "OpenAI",
];
function buildSlices(rows: CostSplitRow[]): DonutSlice[] {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.provider, r.spend);
  const slices: DonutSlice[] = PROVIDER_ORDER.map((p) => ({
    label: p,
    value: map.get(p) ?? 0,
    color: PROVIDER_COLOR[p] ?? "#5A6268",
  }));
  let other = 0;
  for (const [k, v] of map.entries()) {
    if (!PROVIDER_ORDER.includes(k)) other += v;
  }
  if (other > 0) {
    slices.push({ label: "Other", value: other, color: PROVIDER_COLOR.Other });
  }
  return slices;
}

function pctDelta(cur: number, prior: number): { text: string; dir: "up" | "down" | "neutral" } {
  if (prior === 0) {
    if (cur === 0) return { text: "no change", dir: "neutral" };
    return { text: "new", dir: "up" };
  }
  const pct = ((cur - prior) / prior) * 100;
  const r = Math.abs(pct) < 0.05 ? 0 : pct;
  const sign = r > 0 ? "+" : "";
  return {
    text: `${sign}${r.toFixed(1)}% vs yest`,
    dir: r > 0 ? "up" : r < 0 ? "down" : "neutral",
  };
}

async function fetchSnapshot(): Promise<OverviewSnapshot> {
  const { data, error } = await rpc<OverviewSnapshot>("admin_overview_snapshot");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("admin_overview_snapshot returned no data");
  return data;
}
async function fetchCostSplit(): Promise<CostSplitRow[]> {
  const { data, error } = await rpc<CostSplitRow[]>("admin_overview_cost_split");
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchTopUsers(): Promise<TopUserRow[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await rpc<TopUserRow[]>("admin_top_users_by_spend", {
    p_since: since, p_limit: 5,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function fetchFeed(filter: ActivityFilter): Promise<ActivityFeedRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await rpc<ActivityFeedRow[]>("admin_activity_feed", {
    p_since: since,
    p_user_id: null,
    p_event_types: eventTypesFor(filter),
    p_limit: 10,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function mapFeedItems(rows: ActivityFeedRow[]): FeedItem[] {
  return rows.map((r, idx) => ({
    id: `${r.created_at}-${r.event_type ?? "x"}-${idx}`,
    tone: toneFor(r.event_type),
    glyph: glyphFor(r.event_type),
    t: new Date(r.created_at),
    bodyText: r.message ?? r.event_type ?? "(no message)",
    metaTokens: [r.event_type ?? r.category ?? "event"],
  }));
}

export function TabOverview(): JSX.Element {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseFilter(searchParams.get("activity"));

  const setFilter = (next: ActivityFilter): void => {
    const params = new URLSearchParams(searchParams);
    if (next === "live") params.delete("activity"); else params.set("activity", next);
    setSearchParams(params, { replace: true });
  };

  const snapshot = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("overview", "snapshot"),
    queryFn: fetchSnapshot,
  });
  const costSplit = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("overview", "cost-split"),
    queryFn: fetchCostSplit,
  });
  const topUsers = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("overview", "top-users", "7d"),
    queryFn: fetchTopUsers,
  });
  const feed = useQuery({
    ...ADMIN_DEFAULT_QUERY_OPTIONS,
    queryKey: adminKey("overview", "feed", filter),
    queryFn: () => fetchFeed(filter),
  });

  useEffect(() => {
    if (snapshot.error) toast.error("Overview snapshot failed", { id: "ovr-snap" });
    if (costSplit.error) toast.error("Cost split failed", { id: "ovr-cost" });
    if (topUsers.error) toast.error("Top users failed", { id: "ovr-top" });
    if (feed.error) toast.error("Activity feed failed", { id: "ovr-feed" });
  }, [snapshot.error, costSplit.error, topUsers.error, feed.error]);

  useEffect(() => {
    const channel = supabase
      .channel("admin-tab-overview:system_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_logs" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["admin", "overview", "feed"] });
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

  if (snapshot.isLoading) return <AdminLoading />;

  const snap = snapshot.data;
  const slices = buildSlices(costSplit.data ?? []);
  const totalSpend = slices.reduce((s, x) => s + x.value, 0);
  const top = topUsers.data ?? [];
  const maxSpend = top.reduce((m, u) => Math.max(m, u.spend), 0) || 1;
  const feedItems = mapFeedItems(feed.data ?? []);
  const aD = snap ? pctDelta(snap.active_users_24h, snap.active_users_yesterday) : null;
  const gD = snap ? pctDelta(snap.gens_today, snap.gens_yesterday) : null;
  const dash = "—";

  return (
    <div>
      <div className="kpi-grid">
        <Kpi label="Active users · 24h" tone="cyan" icon={<I.users />}
          value={snap ? fmtNum(snap.active_users_24h) : dash}
          delta={aD?.text} deltaDir={aD?.dir} spark={snap?.active_users_spark} />
        <Kpi label="Credits sold · MTD" icon={<I.credit />}
          value={snap ? short(snap.mtd_credits_sold) : dash} />
        <Kpi label="Generations · today" icon={<I.spark />}
          value={snap ? fmtNum(snap.gens_today) : dash}
          delta={gD?.text} deltaDir={gD?.dir} spark={snap?.gens_spark} />
        <Kpi label="API spend · MTD" sparkColor="#F5B049"
          value={snap ? money(snap.mtd_spend) : dash}
          spark={snap?.mtd_spend_spark} />
        <Kpi label="Errors · 1h" tone="danger" sparkColor="#F5B049"
          value={snap ? fmtNum(snap.errors_1h) : dash}
          delta={snap ? `↓ from ${fmtNum(snap.errors_24h_peak)} peak` : undefined}
          deltaDir={snap && snap.errors_1h <= snap.errors_24h_peak ? "down" : "up"} />
        <Kpi label="Open tickets" icon={<I.mail />}
          value={snap ? fmtNum(snap.open_tickets) : dash}
          delta={dash} deltaDir="neutral" />
      </div>

      <SectionHeader
        title="Live activity"
        right={
          <>
            {FILTERS.map((f) => {
              const active = f.key === filter;
              const Glyph = f.icon ? I[f.icon] : null;
              return (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                  className={"btn-ghost" + (active ? " active" : "")}>
                  {Glyph ? <Glyph /> : null} {f.label}
                </button>
              );
            })}
          </>
        }
      />

      <div className="cols-2-1">
        <div className="card">
          {feed.isLoading ? <AdminLoading /> : feedItems.length === 0 ? (
            <AdminEmpty title="No activity in this window" hint="Try a wider range." />
          ) : <ActivityFeed items={feedItems} />}
        </div>

        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-h">
              <div className="t">Cost split · MTD</div>
              <span className="lbl">{money(totalSpend)}</span>
            </div>
            <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <Donut size={140} slices={slices} />
              <div className="legend" style={{ flex: 1 }}>
                {slices.slice(0, 4).map((sl) => {
                  const pct = totalSpend === 0 ? 0 : (sl.value / totalSpend) * 100;
                  return (
                    <div className="row" key={sl.label}>
                      <span className="sw" style={{ background: sl.color }} />
                      <span className="lbl">{sl.label}</span>
                      <span className="v">{money(sl.value)}</span>
                      <span className="pct">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><div className="t">Top users · 7d</div><span className="lbl">by spend</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {top.length === 0
                ? <div className="muted" style={{ fontSize: 12 }}>No paid usage in the last 7 days.</div>
                : top.map((u) => <TopUserRowEl key={u.user_id} u={u} maxSpend={maxSpend} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TopUserRowEl({ u, maxSpend }: { u: TopUserRow; maxSpend: number }): JSX.Element {
  const name = u.display_name ?? "Unknown";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Avatar user={{ name, avatar: u.avatar_url ?? undefined }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
        <div style={{ marginTop: 5 }}><BarTrack pct={(u.spend / maxSpend) * 100} /></div>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--ink-dim)", width: 64, textAlign: "right" }}>{money(u.spend)}</div>
    </div>
  );
}
