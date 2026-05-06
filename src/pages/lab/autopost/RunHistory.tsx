/**
 * Autopost run history page.
 *
 * Restyled (2026-05-06) to the Autopost Lab dense-row design:
 *   - Lab crumb + serif page hero matching AutopostHome.
 *   - Filter card with 4 native <select> dropdowns themed to the
 *     dark surface (.fil-grid).
 *   - Day-bucketed runs lists. Each row is a compact 5-column grid
 *     (thumbnail / topic + schedule / status pill / timestamp /
 *     details button or actions slot).
 *
 * All wiring is preserved verbatim from the prior implementation:
 *   - Cursor-paginated useQuery against autopost_runs (PAGE_SIZE = 50).
 *   - Cumulative accumulator with dedupe by id.
 *   - Realtime channel on autopost_runs + autopost_publish_jobs.
 *   - performDelete / performRegenerate flows are byte-identical.
 *
 * Filter logic still runs server-side (status / schedule / date) with
 * the platform filter applied client-side because it's a function of
 * the joined publish_jobs.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Image as ImageIcon, Inbox, Plus, RefreshCw, RotateCw, Trash2, FlaskConical,
} from "lucide-react";
import { Helmet } from "react-helmet-async";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import AppShell from "@/components/dashboard/AppShell";
import { AutopostNav } from "./_AutopostNav";
import {
  isRunStatusActive, relativeTime, dayBucketLabel, dayBucketKey,
} from "./_autopostUi";

const PAGE_SIZE = 50;

type StatusFilter = "all" | "queued" | "generating" | "rendered" | "publishing" | "completed" | "failed" | "cancelled";
type PlatformFilter = "all" | "youtube" | "instagram" | "tiktok";
type DateFilter = "today" | "7d" | "30d" | "all";

interface RunRow {
  id: string;
  fired_at: string;
  status: string;
  schedule_id: string;
  topic: string | null;
  thumbnail_url: string | null;
  error_summary: string | null;
  progress_pct: number | null;
  /** Source render job. Used by Regenerate to look up the project +
   *  generation IDs for the rerender payload. */
  video_job_id: string | null;
  schedule: { name: string } | null;
  publish_jobs: Array<{ platform: string; status: string }>;
}

interface ScheduleOption {
  id: string;
  name: string;
}

function dateLowerBound(filter: DateFilter): string | null {
  const now = Date.now();
  if (filter === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  if (filter === "7d")  return new Date(now - 7  * 86_400_000).toISOString();
  if (filter === "30d") return new Date(now - 30 * 86_400_000).toISOString();
  return null;
}

export default function RunHistory() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [scheduleFilter, setScheduleFilter] = useState<string>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("7d");
  const [page, setPage] = useState(1);

  // Reset page when any filter changes — paginating into a different
  // result set would feel broken otherwise.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, scheduleFilter, platformFilter, dateFilter]);

  const schedulesQuery = useQuery<ScheduleOption[]>({
    queryKey: ["autopost", "schedules-for-filter"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("autopost_schedules")
        .select("id, name")
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ScheduleOption[];
    },
    staleTime: 60_000,
  });

  // Cumulative cache of pages we've already fetched. Cursor pagination
  // requests ONE page at a time (range(from, to)) and we merge into the
  // accumulator below, so "Load more" no longer re-downloads the first
  // N×PAGE_SIZE rows on every click.
  const [accumulatedRuns, setAccumulatedRuns] = useState<RunRow[]>([]);

  // Reset the accumulator whenever a filter changes (the next page-1
  // fetch will repopulate it from scratch).
  useEffect(() => {
    setAccumulatedRuns([]);
  }, [statusFilter, scheduleFilter, dateFilter]);

  const queryKey = ["autopost", "runs", { statusFilter, scheduleFilter, dateFilter, page }] as const;
  const runsQuery = useQuery<RunRow[]>({
    queryKey,
    queryFn: async () => {
      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let query = supabase
        .from("autopost_runs")
        .select(
          "id, fired_at, status, schedule_id, topic, thumbnail_url, error_summary, progress_pct, video_job_id, schedule:autopost_schedules(name), publish_jobs:autopost_publish_jobs(platform, status)",
        )
        .order("fired_at", { ascending: false })
        .range(from, to);

      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (scheduleFilter !== "all") query = query.eq("schedule_id", scheduleFilter);

      const lower = dateLowerBound(dateFilter);
      if (lower) query = query.gte("fired_at", lower);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as RunRow[];
    },
    staleTime: 5_000,
  });

  // Merge each page into the accumulator. Page 1 replaces; subsequent
  // pages append (with a dedupe by id so a realtime invalidation that
  // re-fetches page 1 doesn't double-render rows we already have).
  useEffect(() => {
    const data = runsQuery.data;
    if (!data) return;
    setAccumulatedRuns(prev => {
      if (page === 1) return data;
      const seen = new Set(prev.map(r => r.id));
      const additions = data.filter(r => !seen.has(r.id));
      return [...prev, ...additions];
    });
  }, [runsQuery.data, page]);

  // Realtime — copy of the AdminQueueMonitor pattern, debounced.
  // With cursor pagination we snap back to page 1 on each event so new
  // rows surface at the top; the accumulator's effect-merge then
  // replaces the cached snapshot with the fresh page-1 data.
  useEffect(() => {
    const debouncedRefetch = debounce(() => {
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] });
    }, 300);
    const channel = supabase
      .channel("lab-autopost-runs")
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_runs" }, () => debouncedRefetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "autopost_publish_jobs" }, () => debouncedRefetch())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const visibleRows = useMemo(() => {
    if (platformFilter === "all") return accumulatedRuns;
    return accumulatedRuns.filter(r => r.publish_jobs.some(p => p.platform === platformFilter));
  }, [accumulatedRuns, platformFilter]);

  const grouped = useMemo(() => groupByDay(visibleRows), [visibleRows]);

  // The "load more" button is only meaningful when the most recent page
  // fetch came back full — fewer rows = end of the result set.
  const hasMore = (runsQuery.data?.length ?? 0) >= PAGE_SIZE;

  const handleRowClick = useCallback(
    (id: string) => navigate(`/lab/autopost/runs/${id}`),
    [navigate],
  );

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  async function performDelete() {
    if (!pendingDeleteId) return;
    setIsDeleting(true);
    const { error } = await supabase
      .from("autopost_runs")
      .delete()
      .eq("id", pendingDeleteId);
    setIsDeleting(false);
    if (error) {
      toast.error(`Couldn't delete run: ${error.message}`);
      return;
    }
    toast.success("Run deleted");
    setPendingDeleteId(null);
    queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] });
  }

  /** Re-render an existing autopost project keeping the same script.
   *  Resolves projectId + generationId via the run's source video job,
   *  then queues an `autopost_rerender` task. The worker handler will
   *  fan out audio/image/video/finalize/export jobs against the
   *  existing scenes (no script regeneration). */
  async function performRegenerate(run: RunRow) {
    if (!run.video_job_id) {
      toast.error("This run has no source job to regenerate from");
      return;
    }
    setRegeneratingId(run.id);
    try {
      const { data: srcJob, error: srcErr } = await supabase
        .from("video_generation_jobs")
        .select("project_id, payload")
        .eq("id", run.video_job_id)
        .maybeSingle();
      if (srcErr || !srcJob) throw new Error(srcErr?.message ?? "Source job not found");
      const projectId =
        (srcJob as { project_id?: string | null }).project_id ??
        ((srcJob as { payload?: Record<string, unknown> | null }).payload?.projectId as string | undefined);
      if (!projectId) throw new Error("Source job is missing a project_id");

      const { data: gen, error: genErr } = await supabase
        .from("generations")
        .select("id")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (genErr || !gen) throw new Error("Source generation not found for project");
      const generationId = (gen as { id: string }).id;

      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Not signed in");

      const { error: insertErr } = await supabase
        .from("video_generation_jobs")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({
          user_id: userId,
          project_id: projectId,
          task_type: "autopost_rerender",
          status: "pending",
          payload: { projectId, generationId } as never,
        } as never);
      if (insertErr) throw insertErr;
      toast.success("Regeneration queued — same script, fresh visuals");
      queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not queue regeneration");
    } finally {
      setRegeneratingId(null);
    }
  }

  return (
    <AppShell breadcrumb="Lab · Runs">
      <Helmet>
        <title>Run history · Autopost · Lab · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="autopost-shell">
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "28px 32px 80px" }}>
          {/* Lab crumb */}
          <div className="lab-crumb">
            <FlaskConical width={13} height={13} />
            <Link to="/lab">Lab</Link>
            <span className="sep">›</span>
            <Link to="/lab/autopost">Autopost</Link>
            <span className="sep">›</span>
            <span className="cur">Runs</span>
          </div>

          {/* Page hero */}
          <div className="ap-head">
            <div>
              <h1>Run <em>history</em></h1>
              <p className="lede">
                Every schedule fire and on-demand test render. Click a row to
                drill into per-platform timelines.
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] })}
              disabled={runsQuery.isFetching}
            >
              <RefreshCw width={13} height={13} className={runsQuery.isFetching ? "autopost-spin" : undefined} />
              Refresh
            </button>
          </div>

          <AutopostNav />

          {/* Filter bar */}
          <div className="fil-card">
            <div className="fil-grid">
              <div className="fld">
                <label htmlFor="rh-status">Status</label>
                <select
                  id="rh-status"
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                >
                  <option value="all">All statuses</option>
                  <option value="queued">Queued</option>
                  <option value="generating">Generating</option>
                  <option value="rendered">Rendered</option>
                  <option value="publishing">Publishing</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div className="fld">
                <label htmlFor="rh-sched">Schedule</label>
                <select
                  id="rh-sched"
                  value={scheduleFilter}
                  onChange={e => setScheduleFilter(e.target.value)}
                >
                  <option value="all">All schedules</option>
                  {(schedulesQuery.data ?? []).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label htmlFor="rh-platform">Platform</label>
                <select
                  id="rh-platform"
                  value={platformFilter}
                  onChange={e => setPlatformFilter(e.target.value as PlatformFilter)}
                >
                  <option value="all">All platforms</option>
                  <option value="youtube">YouTube</option>
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                </select>
              </div>
              <div className="fld">
                <label htmlFor="rh-date">Date</label>
                <select
                  id="rh-date"
                  value={dateFilter}
                  onChange={e => setDateFilter(e.target.value as DateFilter)}
                >
                  <option value="today">Today</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                </select>
              </div>
            </div>
          </div>

          {/* Body */}
          {runsQuery.isLoading ? (
            <ListSkeleton />
          ) : runsQuery.isError ? (
            <div className="runs-card" style={{ padding: 40, textAlign: "center" }}>
              <span style={{ color: "var(--gold)", fontSize: 13 }}>
                Couldn't load runs: {(runsQuery.error as Error)?.message ?? "unknown error"}
              </span>
            </div>
          ) : grouped.length === 0 ? (
            <div className="runs-card" style={{ padding: "48px 24px", textAlign: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 56, height: 56, borderRadius: "50%",
                    background: "rgba(20,200,204,0.1)",
                    display: "grid", placeItems: "center",
                    color: "var(--cyan)",
                  }}
                >
                  <Inbox width={28} height={28} />
                </div>
                <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: 0, color: "var(--ink)" }}>
                  No runs yet
                </h2>
                <p style={{ color: "var(--ink-dim)", fontSize: 13, maxWidth: 460, margin: 0, lineHeight: 1.55 }}>
                  Once a schedule fires (or a manual test render is triggered), each run
                  lands here with a thumbnail, status, and per-platform publish state.
                </p>
                <Link to="/app/create/new?mode=cinematic" className="btn-cyan" style={{ marginTop: 8 }}>
                  <Plus width={14} height={14} />
                  Create a schedule
                </Link>
              </div>
            </div>
          ) : (
            <>
              {grouped.map(group => (
                <div key={group.key} className="day-bucket">
                  <div className="lbl">
                    {group.label}
                    <span className="ct">{group.runs.length} {group.runs.length === 1 ? "run" : "runs"}</span>
                  </div>
                  <div className="runs-card">
                    {group.runs.map(run => (
                      <RunListItem
                        key={run.id}
                        run={run}
                        onClick={() => handleRowClick(run.id)}
                        onDelete={(id) => setPendingDeleteId(id)}
                        onRegenerate={performRegenerate}
                        regenerating={regeneratingId === run.id}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {hasMore && (
                <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setPage(p => p + 1)}
                    disabled={runsQuery.isFetching}
                  >
                    {runsQuery.isFetching ? "Loading…" : "Load more"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
      >
        <AlertDialogContent className="autopost-modal-content">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              The run row, its publish jobs, and its thumbnail will be removed
              permanently. The rendered video itself stays in your library — only
              the autopost history entry is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
              disabled={isDeleting}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={performDelete}
              disabled={isDeleting}
              className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#E4C875]/90"
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

/**
 * Compact 9:16 thumbnail tile sized for the dense list. Always renders
 * a real frame in slots so a missing thumbnail looks intentional, not
 * broken: in-flight runs get a shimmer overlay, failed runs get a gold
 * fail glyph, completed-without-thumb keeps the muted image icon.
 */
function RunThumb({ run }: { run: RunRow }) {
  const active = isRunStatusActive(run.status);
  const failed = run.status === "failed";
  if (failed && !run.thumbnail_url) {
    return <div className="thumb fail">!</div>;
  }
  return (
    <div className="thumb">
      {run.thumbnail_url ? (
        <img
          src={run.thumbnail_url}
          alt=""
          loading="lazy"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
      {!run.thumbnail_url && active && (
        <div
          aria-hidden
          className="absolute inset-0 animate-shimmer"
          style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(180deg, transparent, rgba(20,200,204,0.35), transparent)",
          }}
        />
      )}
      {!run.thumbnail_url && !active && !failed && (
        <ImageIcon width={14} height={14} />
      )}
    </div>
  );
}

function RunListItem({
  run,
  onClick,
  onDelete,
  onRegenerate,
  regenerating,
}: {
  run: RunRow;
  onClick: () => void;
  onDelete: (id: string) => void;
  onRegenerate: (run: RunRow) => void;
  regenerating: boolean;
}) {
  const isFailed = run.status === "failed";
  const isCompleted = run.status === "completed";
  const title = run.topic || run.schedule?.name || "(untitled run)";
  return (
    <div
      className="run-row"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
      }}
    >
      <RunThumb run={run} />
      <div className="run-meta">
        <div className="t" title={title}>{title}</div>
        <div className="s">{run.schedule?.name ?? "—"}</div>
      </div>
      <span className={`run-pill ${run.status}`}>{run.status}</span>
      <span className="when">{relativeTime(run.fired_at)}</span>
      <div className="run-actions" onClick={(e) => e.stopPropagation()}>
        {isFailed && run.error_summary && (
          <button
            type="button"
            className="show-det"
            onClick={() => onClick()}
            aria-label="Show error details"
          >
            DETAILS
          </button>
        )}
        {isCompleted && run.video_job_id && (
          <button
            type="button"
            onClick={() => onRegenerate(run)}
            disabled={regenerating}
            aria-label="Regenerate run with same script"
            title="Regenerate (keep script, fresh audio + images + videos + export)"
          >
            <RotateCw width={13} height={13} className={regenerating ? "autopost-spin" : undefined} />
          </button>
        )}
        <button
          type="button"
          className="del"
          onClick={() => onDelete(run.id)}
          aria-label="Delete run"
          title="Delete run"
        >
          <Trash2 width={13} height={13} />
        </button>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="runs-card" style={{ padding: "16px 20px" }}>
      {[0, 1, 2, 3].map(i => (
        <div
          key={i}
          style={{
            display: "flex", alignItems: "center", gap: 14, padding: "10px 0",
            borderTop: i === 0 ? 0 : "1px solid rgba(255,255,255,0.04)",
          }}
        >
          <div style={{ width: 30, height: 54, borderRadius: 4, background: "rgba(255,255,255,0.05)" }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ height: 12, width: "40%", borderRadius: 3, background: "rgba(255,255,255,0.05)" }} />
            <div style={{ height: 10, width: "25%", borderRadius: 3, background: "rgba(255,255,255,0.05)" }} />
          </div>
          <div style={{ height: 18, width: 80, borderRadius: 99, background: "rgba(255,255,255,0.05)" }} />
        </div>
      ))}
    </div>
  );
}

interface DayGroup {
  key: string;
  label: string;
  runs: RunRow[];
}

function groupByDay(rows: RunRow[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const row of rows) {
    const key = dayBucketKey(row.fired_at);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: dayBucketLabel(row.fired_at), runs: [] };
      groups.set(key, g);
    }
    g.runs.push(row);
  }
  return Array.from(groups.values());
}

/** Tiny inline debounce. */
function debounce<F extends (...args: unknown[]) => unknown>(fn: F, ms: number): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as F;
}
