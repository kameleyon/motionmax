import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ActivityFeed, type FeedItem, type FeedTone, type IconKey } from "@/components/admin/_shared/ActivityFeed";
import { AdminEmpty } from "@/components/admin/_shared/AdminEmpty";
import { AdminLoading } from "@/components/admin/_shared/AdminLoading";
import { Pill } from "@/components/admin/_shared/Pill";
import { SearchRow } from "@/components/admin/_shared/SearchRow";
import { SectionHeader } from "@/components/admin/_shared/SectionHeader";
import { Toggle } from "@/components/admin/_shared/Toggle";
import { adminKey } from "@/components/admin/_shared/queries";

/* ── Types ─────────────────────────────────────────────────────────── */

export type FeedRow = {
  id: string;
  source: "system" | "admin" | "credit";
  event_type: string;
  category: string;
  user_id: string | null;
  message: string;
  details: Record<string, unknown>;
  generation_id: string | null;
  project_id: string | null;
  created_at: string;
};

type SearchHit = { kind: "user" | "project" | "generation" | "api_call"; id: string; title: string; subtitle: string | null };
type TimeRange = "1h" | "24h" | "7d" | "30d";
type EventGroup = "all" | "gen" | "pay" | "auth" | "voice" | "admin" | "errors";

const TIME_RANGES: ReadonlyArray<{ key: TimeRange; label: string; ms: number }> = [
  { key: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { key: "24h", label: "24 h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7 d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30 d", ms: 30 * 24 * 60 * 60 * 1000 },
];

const EVENT_GROUPS: Record<EventGroup, { label: string; prefixes: string[] | null; categories?: string[] }> = {
  all:    { label: "All", prefixes: null },
  gen:    { label: "Generations", prefixes: ["gen."] },
  pay:    { label: "Billing", prefixes: ["pay."] },
  auth:   { label: "Auth", prefixes: ["user.signed_"] },
  voice:  { label: "Voice", prefixes: ["voice."] },
  admin:  { label: "Admin", prefixes: null, categories: ["admin_action"] },
  errors: { label: "Errors", prefixes: null, categories: ["system_error"] },
};

const PAGE_LIMIT = 100;
const BUFFER_CAP = 200;

/* ── Helpers ───────────────────────────────────────────────────────── */

function rangeToSinceISO(range: TimeRange): string {
  const def = TIME_RANGES.find((r) => r.key === range) ?? TIME_RANGES[1];
  return new Date(Date.now() - def.ms).toISOString();
}

function parseGroups(raw: string | null): EventGroup[] {
  if (!raw) return ["all"];
  const out = raw.split(",").map((t) => t.trim()).filter((t) => t in EVENT_GROUPS) as EventGroup[];
  return out.length === 0 ? ["all"] : out;
}

function buildEventTypesArg(groups: EventGroup[]): string[] | null {
  if (groups.includes("all")) return null;
  const set = new Set<string>();
  for (const g of groups) EVENT_GROUPS[g].prefixes?.forEach((p) => set.add(p));
  return set.size > 0 ? Array.from(set) : null;
}

function rowMatches(row: FeedRow, groups: EventGroup[]): boolean {
  if (groups.includes("all")) return true;
  for (const g of groups) {
    const cfg = EVENT_GROUPS[g];
    if (cfg.categories?.includes(row.category)) return true;
    if (cfg.prefixes?.some((p) => row.event_type.startsWith(p))) return true;
  }
  return false;
}

function toneFor(row: FeedRow): FeedTone {
  if (row.category === "system_error" || row.event_type.endsWith(".failed")) return "err";
  if (row.event_type.endsWith(".completed")) return "ok";
  if (row.source === "credit" || row.event_type.startsWith("pay.") || row.event_type.startsWith("voice.")) return "cyan";
  if (row.category === "admin_action") return "warn";
  return "default";
}

function glyphFor(row: FeedRow): IconKey {
  if (row.category === "system_error" || row.event_type.endsWith(".failed")) return "alert";
  if (row.source === "credit" || row.event_type.startsWith("pay.")) return "credit";
  if (row.event_type.startsWith("user.signed_")) return "shield";
  if (row.event_type.startsWith("voice.")) return "voicebars";
  if (row.event_type.startsWith("gen.")) return "spark";
  if (row.category === "admin_action") return "shield";
  return "bolt";
}

function toFeedItem(row: FeedRow): FeedItem {
  return {
    id: row.id, tone: toneFor(row), glyph: glyphFor(row),
    t: new Date(row.created_at), bodyText: row.message,
    metaTokens: [row.event_type, row.source],
  };
}

type RpcCall = (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
const rpcUntyped = supabase.rpc.bind(supabase) as unknown as RpcCall;

async function fetchFeedPage(args: { since: string; userId: string | null; eventTypes: string[] | null; limit: number }): Promise<FeedRow[]> {
  const { data, error } = await rpcUntyped("admin_activity_feed", {
    p_since: args.since, p_user_id: args.userId, p_event_types: args.eventTypes, p_limit: args.limit,
  });
  if (error) throw error;
  return (data as FeedRow[] | null) ?? [];
}

async function fetchUserSearch(query: string): Promise<SearchHit[]> {
  if (query.trim().length < 2) return [];
  const { data, error } = await rpcUntyped("admin_global_search", { q: query.trim(), limit_per_table: 5 });
  if (error) throw error;
  return ((data as SearchHit[] | null) ?? []).filter((r) => r.kind === "user");
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TabActivity() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const initialGroups = useMemo(() => parseGroups(searchParams.get("event_types")), [searchParams]);
  const initialRange = (searchParams.get("time") as TimeRange | null) ?? "24h";
  const [groups, setGroups] = useState<EventGroup[]>(initialGroups);
  const [range, setRange] = useState<TimeRange>(
    TIME_RANGES.some((r) => r.key === initialRange) ? initialRange : "24h",
  );
  const [userId, setUserId] = useState<string | null>(searchParams.get("user_id"));
  const [live, setLive] = useState<boolean>(searchParams.get("live") !== "0");

  const [searchValue, setSearchValue] = useState("");
  const [debounced, setDebounced] = useState("");
  const [acOpen, setAcOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<SearchHit | null>(null);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(searchValue.trim()), 250);
    return () => window.clearTimeout(h);
  }, [searchValue]);

  // Sync state → URL
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "activity");
    if (groups.length === 0 || (groups.length === 1 && groups[0] === "all")) next.delete("event_types");
    else next.set("event_types", groups.join(","));
    next.set("time", range);
    if (userId) next.set("user_id", userId); else next.delete("user_id");
    next.set("live", live ? "1" : "0");
    navigate(`/admin?${next.toString()}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, range, userId, live]);

  const since = useMemo(() => rangeToSinceISO(range), [range]);
  const eventTypesArg = useMemo(() => buildEventTypesArg(groups), [groups]);

  const [pages, setPages] = useState<FeedRow[][]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  const baseQuery = useQuery({
    queryKey: adminKey("activity", "feed", since, userId, eventTypesArg?.join(",") ?? "*"),
    queryFn: () => fetchFeedPage({ since, userId, eventTypes: eventTypesArg, limit: PAGE_LIMIT }),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (baseQuery.data) {
      setPages([baseQuery.data]);
      setReachedEnd(baseQuery.data.length < PAGE_LIMIT);
    }
  }, [baseQuery.data]);

  const [liveBuffer, setLiveBuffer] = useState<FeedRow[]>([]);

  // Realtime: admin-activity-feed:system_logs
  useEffect(() => {
    if (!live) return;
    const channel = supabase
      .channel("admin-activity-feed:system_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_logs" },
        (payload) => {
          const r = payload.new as Partial<FeedRow> & {
            id?: string; event_type?: string; category?: string; user_id?: string | null;
            message?: string; details?: Record<string, unknown> | null;
            generation_id?: string | null; project_id?: string | null; created_at?: string;
          };
          if (!r.id || !r.created_at || !r.event_type || !r.category || !r.message) return;
          const row: FeedRow = {
            id: r.id, source: "system",
            event_type: r.event_type, category: r.category,
            user_id: r.user_id ?? null, message: r.message,
            details: r.details ?? {},
            generation_id: r.generation_id ?? null, project_id: r.project_id ?? null,
            created_at: r.created_at,
          };
          if (userId && row.user_id !== userId) return;
          if (!rowMatches(row, groups)) return;
          setLiveBuffer((prev) => [row, ...prev].slice(0, BUFFER_CAP));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [live, userId, groups]);

  useEffect(() => { setLiveBuffer([]); }, [since, userId, eventTypesArg]);

  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd) return;
    const lastPage = pages[pages.length - 1];
    if (!lastPage || lastPage.length === 0) return;
    const oldest = lastPage[lastPage.length - 1];
    setLoadingMore(true);
    try {
      const next = await fetchFeedPage({
        since: oldest.created_at, userId, eventTypes: eventTypesArg, limit: PAGE_LIMIT,
      });
      const filtered = next.filter((r) => r.id !== oldest.id);
      setPages((prev) => [...prev, filtered]);
      if (filtered.length < PAGE_LIMIT) setReachedEnd(true);
    } finally { setLoadingMore(false); }
  }, [pages, loadingMore, reachedEnd, userId, eventTypesArg]);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || reachedEnd) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore(); },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, reachedEnd]);

  const userSearchQ = useQuery({
    queryKey: adminKey("activity", "user-search", debounced),
    queryFn: () => fetchUserSearch(debounced),
    enabled: debounced.length >= 2 && acOpen,
    staleTime: 30_000,
  });

  const onPickUser = (hit: SearchHit) => {
    setSelectedUser(hit); setUserId(hit.id);
    setSearchValue(hit.title); setAcOpen(false);
  };
  const onClearUser = () => { setSelectedUser(null); setUserId(null); setSearchValue(""); };

  const [expandedId, setExpandedId] = useState<string | null>(null);

  const allRows = useMemo<FeedRow[]>(() => {
    const seen = new Set<string>();
    const out: FeedRow[] = [];
    for (const r of liveBuffer) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    for (const page of pages) for (const r of page) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    return out;
  }, [pages, liveBuffer]);

  const items = useMemo<FeedItem[]>(() => allRows.map(toFeedItem), [allRows]);

  if (baseQuery.isLoading && pages.length === 0) return <AdminLoading />;

  const expandedRow = expandedId ? allRows.find((r) => r.id === expandedId) ?? null : null;

  const toggleGroup = (g: EventGroup) => {
    if (g === "all") { setGroups(["all"]); return; }
    const without = groups.filter((x) => x !== "all" && x !== g);
    const on = groups.includes(g);
    const next = on ? without : [...without, g];
    setGroups(next.length === 0 ? ["all"] : next);
  };
  const selectStyle: React.CSSProperties = {
    background: "var(--panel-3)", borderColor: "var(--line)", borderWidth: 1, color: "var(--ink)",
  };
  const expandedBoxStyle: React.CSSProperties = {
    background: "var(--panel-3)", border: "1px dashed var(--line)",
  };
  const linkRowItems: Array<[string | null, string, string]> = expandedRow ? [
    [expandedRow.user_id, "users", "user"],
    [expandedRow.generation_id, "gens", "generation"],
    [expandedRow.project_id, "gens", "project"],
  ] : [];

  return (
    <div className="space-y-4">
      <SectionHeader title="Activity feed" right={
        <div className="flex flex-wrap items-center gap-2">
          <div style={{ position: "relative" }}>
            <SearchRow minWidth={240} ariaLabel="Filter by user"
              placeholder={selectedUser ? selectedUser.title : "Search by user…"}
              value={searchValue}
              onChange={(v) => { setSearchValue(v); setAcOpen(true); }} />
            {acOpen && debounced.length >= 2 && (userSearchQ.data?.length ?? 0) > 0 && (
              <div role="listbox" className="absolute z-50 mt-1 w-full rounded-md border"
                style={{ background: "var(--panel-2)", borderColor: "var(--line)" }}>
                {(userSearchQ.data ?? []).map((hit) => (
                  <button key={`${hit.kind}-${hit.id}`} type="button"
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-[var(--panel-3)]"
                    style={{ color: "var(--ink)" }} onClick={() => onPickUser(hit)}>
                    <div>{hit.title}</div>
                    {hit.subtitle && (
                      <div className="font-mono text-[10px]" style={{ color: "var(--ink-mute)" }}>{hit.subtitle}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedUser && (
            <button type="button" onClick={onClearUser} className="btn-ghost">Clear user</button>
          )}
          <div className="flex items-center gap-1">
            {(Object.keys(EVENT_GROUPS) as EventGroup[]).map((g) => (
              <button key={g} type="button"
                className={"btn-ghost" + (groups.includes(g) ? " active" : "")}
                onClick={() => toggleGroup(g)}>
                {EVENT_GROUPS[g].label}
              </button>
            ))}
          </div>
          <select value={range} onChange={(e) => setRange(e.target.value as TimeRange)}
            className="rounded-md px-2 py-1 text-xs" style={selectStyle} aria-label="Time range">
            {TIME_RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          <div className="flex items-center gap-1.5">
            <Toggle checked={live} onChange={setLive} ariaLabel="Toggle realtime" />
            <Pill variant={live ? "ok" : "default"} dot={live}>Live</Pill>
          </div>
        </div>
      } />

      {items.length === 0 ? (
        <AdminEmpty title="No activity in this window" hint="Try a wider range or different filters." />
      ) : (
        <div className="card">
          <ActivityFeed items={items.map((it) => ({
            ...it,
            bodyText: (
              <button type="button" onClick={() => setExpandedId((p) => (p === it.id ? null : it.id))}
                style={{ background: "none", border: 0, padding: 0, color: "inherit", textAlign: "left", cursor: "pointer", font: "inherit" }}>
                {it.bodyText}
              </button>
            ),
          }))} />
          {expandedRow && (
            <div className="mt-3 rounded-md p-3" style={expandedBoxStyle}>
              <div className="font-mono text-[10px] uppercase mb-2" style={{ color: "var(--ink-mute)" }}>
                Event details · {expandedRow.event_type}
              </div>
              <pre className="text-xs overflow-auto max-h-72"
                style={{ color: "var(--ink-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {JSON.stringify(expandedRow.details, null, 2)}
              </pre>
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                {linkRowItems.map(([id, tab, label]) => id ? (
                  <a key={label} className="underline" href={`/admin?tab=${tab}&${label}_id=${id}`}>{label}</a>
                ) : null)}
              </div>
            </div>
          )}
          <div ref={sentinelRef} style={{ height: 1 }} />
          {!reachedEnd && (
            <div className="mt-3 text-center">
              <button type="button" className="btn-ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
