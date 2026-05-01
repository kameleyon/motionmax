/**
 * Autopost run history page.
 *
 * Reverse-chronological list of every autopost_runs row that the
 * current admin can see (RLS gates by schedule ownership). Filters
 * across status / schedule / platform / date-range, paginates by 50,
 * groups by day with sticky-feeling section headers, and updates
 * realtime via postgres_changes on autopost_runs and autopost_publish_jobs.
 *
 * The realtime subscription mirrors AdminQueueMonitor: '*' events on
 * the relevant tables, debounced to one refetch per 300ms so a burst
 * of 10 publish-job updates only triggers one round-trip.
 *
 * Data shape: each run row carries a precomputed `publish_jobs` array
 * (joined in the same SELECT) holding {platform, status, ...} so the
 * row pills don't need a per-row fetch. Filter logic runs on the
 * server (status/schedule/date) but platform filter happens
 * client-side because it's a function of the joined publish_jobs.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Inbox, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LabLayout } from "../_LabLayout";
import { AutopostNav } from "./_AutopostNav";
import {
  StatusPill, PlatformPill, RunProgressBar, isRunStatusActive,
  relativeTime, dayBucketLabel, dayBucketKey,
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

  const queryKey = ["autopost", "runs", { statusFilter, scheduleFilter, dateFilter, page }] as const;
  const runsQuery = useQuery<RunRow[]>({
    queryKey,
    queryFn: async () => {
      let query = supabase
        .from("autopost_runs")
        .select(
          "id, fired_at, status, schedule_id, topic, thumbnail_url, error_summary, progress_pct, schedule:autopost_schedules(name), publish_jobs:autopost_publish_jobs(platform, status)",
        )
        .order("fired_at", { ascending: false })
        .limit(page * PAGE_SIZE);

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

  // Realtime — copy of the AdminQueueMonitor pattern, debounced.
  useEffect(() => {
    const debouncedRefetch = debounce(() => {
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
    const rows = runsQuery.data ?? [];
    if (platformFilter === "all") return rows;
    return rows.filter(r => r.publish_jobs.some(p => p.platform === platformFilter));
  }, [runsQuery.data, platformFilter]);

  const grouped = useMemo(() => groupByDay(visibleRows), [visibleRows]);

  // The "load more" button is only meaningful when the server returned
  // exactly `page * PAGE_SIZE` rows (i.e. it filled the limit, so there
  // might be more). When fewer come back, we've hit the end.
  const hasMore = (runsQuery.data?.length ?? 0) >= page * PAGE_SIZE;

  const handleRowClick = useCallback(
    (id: string) => navigate(`/lab/autopost/runs/${id}`),
    [navigate],
  );

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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

  return (
    <LabLayout
      heading="Run history"
      title="Run history · Autopost · Lab"
      description="Every schedule fire and on-demand test render. Click a row to drill into per-platform timelines."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Runs" },
      ]}
      actions={
        <Button
          variant="outline"
          size="sm"
          className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] })}
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runsQuery.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      }
    >
      <AutopostNav />

      {/* Filter bar */}
      <Card className="bg-[#10151A] border-white/8 mb-4">
        <CardContent className="py-3 sm:py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            <FilterSelect
              label="Status"
              value={statusFilter}
              onChange={v => setStatusFilter(v as StatusFilter)}
              options={[
                { value: "all", label: "All statuses" },
                { value: "queued", label: "Queued" },
                { value: "generating", label: "Generating" },
                { value: "rendered", label: "Rendered" },
                { value: "publishing", label: "Publishing" },
                { value: "completed", label: "Completed" },
                { value: "failed", label: "Failed" },
                { value: "cancelled", label: "Cancelled" },
              ]}
            />
            <FilterSelect
              label="Schedule"
              value={scheduleFilter}
              onChange={setScheduleFilter}
              options={[
                { value: "all", label: "All schedules" },
                ...(schedulesQuery.data ?? []).map(s => ({ value: s.id, label: s.name })),
              ]}
            />
            <FilterSelect
              label="Platform"
              value={platformFilter}
              onChange={v => setPlatformFilter(v as PlatformFilter)}
              options={[
                { value: "all", label: "All platforms" },
                { value: "youtube", label: "YouTube" },
                { value: "instagram", label: "Instagram" },
                { value: "tiktok", label: "TikTok" },
              ]}
            />
            <FilterSelect
              label="Date"
              value={dateFilter}
              onChange={v => setDateFilter(v as DateFilter)}
              options={[
                { value: "today", label: "Today" },
                { value: "7d", label: "Last 7 days" },
                { value: "30d", label: "Last 30 days" },
                { value: "all", label: "All time" },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      {/* Body */}
      {runsQuery.isLoading ? (
        <ListSkeleton />
      ) : runsQuery.isError ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-10 text-center text-[#E4C875] text-[13px]">
            Couldn't load runs: {(runsQuery.error as Error)?.message ?? "unknown error"}
          </CardContent>
        </Card>
      ) : grouped.length === 0 ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 sm:py-16">
            <div className="flex flex-col items-center text-center max-w-md mx-auto space-y-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#11C4D0]/10">
                <Inbox className="h-7 w-7 text-[#11C4D0]" />
              </div>
              <div className="space-y-1.5">
                <h2 className="font-serif text-xl text-[#ECEAE4]">No runs yet</h2>
                <p className="text-[13px] text-[#8A9198] leading-relaxed">
                  Once a schedule fires (or a manual test render is triggered), each run lands
                  here with a thumbnail, status, and per-platform publish state.
                </p>
              </div>
              <Button asChild size="sm" className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90">
                <Link to="/lab/autopost/schedules/new">
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Create a schedule
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {grouped.map(group => (
            <div key={group.key} className="space-y-2">
              <h3
                className="px-1 font-mono text-[11px] uppercase text-[#8A9198]"
                style={{ letterSpacing: "0.14em" }}
              >
                {group.label}
              </h3>
              <Card className="bg-[#10151A] border-white/8 overflow-hidden">
                <ul className="divide-y divide-white/5">
                  {group.runs.map(run => (
                    <li key={run.id}>
                      <RunListItem
                        run={run}
                        onClick={() => handleRowClick(run.id)}
                        onDelete={(id) => setPendingDeleteId(id)}
                      />
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
                onClick={() => setPage(p => p + 1)}
                disabled={runsQuery.isFetching}
              >
                {runsQuery.isFetching ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}
      >
        <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
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
    </LabLayout>
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
  return (
    <div className="shrink-0 overflow-hidden rounded bg-black/40 border border-white/8 w-[27px] h-[48px] sm:w-[30px] sm:h-[54px] relative">
      {run.thumbnail_url ? (
        <img
          src={run.thumbnail_url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : null}
      {!run.thumbnail_url && active && (
        <div
          aria-hidden
          className="absolute inset-0 animate-shimmer"
          style={{ background: "linear-gradient(180deg, transparent, rgba(17,196,208,0.35), transparent)" }}
        />
      )}
      {!run.thumbnail_url && failed && (
        <div className="absolute inset-0 flex items-center justify-center text-[#E4C875]">
          <span className="text-[14px] font-bold">!</span>
        </div>
      )}
      {!run.thumbnail_url && !active && !failed && (
        <div className="absolute inset-0 flex items-center justify-center text-[#3A4248]">
          <ImageIcon className="h-3.5 w-3.5" />
        </div>
      )}
    </div>
  );
}

function RunListItem({
  run,
  onClick,
  onDelete,
}: {
  run: RunRow;
  onClick: () => void;
  onDelete: (id: string) => void;
}) {
  const [errorOpen, setErrorOpen] = useState(false);
  const isActive = isRunStatusActive(run.status);
  const isFailed = run.status === "failed";
  return (
    <>
      <div
        className="group flex w-full items-center gap-3 px-3 py-2 transition-colors hover:bg-white/[0.03] sm:px-4 cursor-pointer min-h-[48px]"
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        }}
      >
        <RunThumb run={run} />

        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <p className="font-medium text-[13px] text-[#ECEAE4] truncate">
              {run.topic || run.schedule?.name || "(untitled run)"}
            </p>
          </div>
          {isActive && (
            <RunProgressBar value={run.progress_pct} className="mt-0.5" />
          )}
        </div>

        <div className="hidden sm:flex items-center gap-2 shrink-0">
          <StatusPill status={run.status} />
          {run.publish_jobs.slice(0, 3).map((j, i) => (
            <PlatformPill key={`${j.platform}-${i}`} platform={j.platform} status={j.status} />
          ))}
        </div>

        <span className="text-[11px] text-[#5A6268] shrink-0 tabular-nums w-[64px] text-right">
          {relativeTime(run.fired_at)}
        </span>

        {isFailed && run.error_summary && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setErrorOpen(o => !o); }}
            className="shrink-0 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider border border-[#E4C875]/30 bg-[#E4C875]/5 text-[#E4C875] hover:bg-[#E4C875]/10"
            aria-label="Show error details"
            aria-expanded={errorOpen}
          >
            {errorOpen ? "Hide details" : "Show details"}
          </button>
        )}

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(run.id); }}
          className="ml-1 shrink-0 rounded-md p-1.5 text-[#5A6268] opacity-0 transition-opacity hover:bg-[#E4C875]/10 hover:text-[#E4C875] group-hover:opacity-100 focus:opacity-100"
          aria-label="Delete run"
          title="Delete run"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {isFailed && errorOpen && run.error_summary && (
        <pre className="mx-3 sm:mx-4 mb-2 mt-1 rounded-md border border-white/8 bg-black/40 px-3 py-2 text-[11px] font-mono text-[#8A9198] whitespace-pre-wrap break-words leading-relaxed">
          {run.error_summary}
        </pre>
      )}
    </>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] uppercase tracking-wide text-[#8A9198] block">
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="bg-[#0A0D0F] border-white/10 text-[#ECEAE4] text-[13px] h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          {options.map(o => (
            <SelectItem key={o.value} value={o.value} className="text-[13px]">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ListSkeleton() {
  return (
    <Card className="bg-[#10151A] border-white/8">
      <CardContent className="py-6 space-y-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-3 animate-pulse">
            <div className="h-[107px] w-[60px] sm:h-[160px] sm:w-[90px] rounded-md bg-white/5" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 rounded bg-white/5" />
              <div className="h-2.5 w-48 rounded bg-white/5" />
              <div className="h-4 w-40 rounded bg-white/5" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
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
