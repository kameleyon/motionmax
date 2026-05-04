/**
 * Per-run detail page.
 *
 * Shows everything we know about a single autopost_runs row:
 *
 *   - Header: schedule name (linked to edit), fired_at relative, status pill,
 *     thumbnail + Watch-rendered-video button.
 *   - Generation: collapsible prompt_resolved (code-style block), topic,
 *     a compact log feed pulled from system_logs WHERE
 *     details->>'autopost_run_id' = run.id ORDER BY created_at.
 *   - Per-platform timeline: one panel per publish_jobs row, with
 *     status progression, attempt count, post URL when published, and
 *     a Retry button when failed.
 *
 * Realtime: subscribe ONLY to changes that affect this run — filter
 * postgres_changes by id (on autopost_runs) and run_id (on
 * autopost_publish_jobs). System_logs polling is best-effort: we
 * refetch every 8s while the run is non-terminal, then stop.
 *
 * The "Approve & Publish" button is left wired-but-hidden per the spec.
 * Wave 3b's wizard will surface an awaiting_approval flag that will
 * unlock it; for now there's no DB column to read so we always hide.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown, ChevronRight, ExternalLink, Image as ImageIcon, Play, RefreshCw,
  Pencil, Trash2,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { LabLayout } from "../_LabLayout";
import { AutopostNav } from "./_AutopostNav";
import {
  StatusPill, PublishStatusPill, platformIcon, platformLabel, relativeTime,
} from "./_autopostUi";

interface RunDetailRow {
  id: string;
  schedule_id: string;
  fired_at: string;
  status: string;
  topic: string | null;
  prompt_resolved: string;
  video_job_id: string | null;
  thumbnail_url: string | null;
  error_summary: string | null;
  schedule: { name: string } | null;
}

interface PublishJobRow {
  id: string;
  platform: string;
  status: string;
  attempts: number;
  scheduled_for: string | null;
  last_attempt_at: string | null;
  platform_post_id: string | null;
  platform_post_url: string | null;
  error_code: string | null;
  error_message: string | null;
  caption: string | null;
  created_at: string;
  updated_at: string;
  social_account: { display_name: string | null } | null;
}

interface VideoJobRow {
  result: { finalUrl?: string; projectId?: string } | null;
  payload: { finalUrl?: string; projectId?: string } | null;
  status: string;
}

interface SystemLogRow {
  id: string;
  category: string;
  event_type: string;
  message: string;
  created_at: string;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export default function RunDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [promptOpen, setPromptOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const runQuery = useQuery<RunDetailRow | null>({
    queryKey: ["autopost", "run", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("autopost_runs")
        .select(
          "id, schedule_id, fired_at, status, topic, prompt_resolved, video_job_id, thumbnail_url, error_summary, schedule:autopost_schedules(name)",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as RunDetailRow | null;
    },
    enabled: !!id,
  });

  const publishJobsQuery = useQuery<PublishJobRow[]>({
    queryKey: ["autopost", "run-jobs", id],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await supabase
        .from("autopost_publish_jobs")
        .select(
          "id, platform, status, attempts, scheduled_for, last_attempt_at, platform_post_id, platform_post_url, error_code, error_message, caption, created_at, updated_at, social_account:autopost_social_accounts(display_name)",
        )
        .eq("run_id", id)
        .order("platform", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PublishJobRow[];
    },
    enabled: !!id,
  });

  // Pull the rendered-video URL on demand. Only enabled when we have
  // a video_job_id; the result is shaped {finalUrl}.
  const videoJobQuery = useQuery<VideoJobRow | null>({
    queryKey: ["autopost", "run-video", runQuery.data?.video_job_id ?? null],
    queryFn: async () => {
      const vid = runQuery.data?.video_job_id;
      if (!vid) return null;
      const { data, error } = await supabase
        .from("video_generation_jobs")
        .select("result, payload, status")
        .eq("id", vid)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as VideoJobRow | null;
    },
    enabled: !!runQuery.data?.video_job_id,
  });

  const logsQuery = useQuery<SystemLogRow[]>({
    queryKey: ["autopost", "run-logs", id],
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await supabase
        .from("system_logs")
        .select("id, category, event_type, message, created_at")
        .filter("details->>autopost_run_id", "eq", id)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as SystemLogRow[];
    },
    enabled: !!id,
    // Keep polling while the run is in flight; stop once terminal.
    refetchInterval: (q) => {
      const status = (q.state.data && q.state.data.length > 0)
        ? runQuery.data?.status ?? ""
        : runQuery.data?.status ?? "";
      return TERMINAL_STATUSES.has(status) ? false : 8_000;
    },
  });

  // Realtime — scoped to this run's id and its publish jobs only, via
  // the postgres_changes filter. One channel for both subscriptions.
  useEffect(() => {
    if (!id) return;
    const channel = supabase
      .channel(`lab-autopost-run-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "autopost_runs", filter: `id=eq.${id}` },
        () => queryClient.invalidateQueries({ queryKey: ["autopost", "run", id] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "autopost_publish_jobs", filter: `run_id=eq.${id}` },
        () => queryClient.invalidateQueries({ queryKey: ["autopost", "run-jobs", id] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!id) return;
      const { error } = await supabase.from("autopost_runs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Run deleted");
      queryClient.invalidateQueries({ queryKey: ["autopost", "runs"] });
      navigate("/lab/autopost/runs");
    },
    onError: (e: Error) => {
      toast.error(`Couldn't delete run: ${e.message}`);
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const { error } = await supabase
        .from("autopost_publish_jobs")
        .update({
          status: "pending",
          attempts: 0,
          scheduled_for: new Date().toISOString(),
          error_code: null,
          error_message: null,
        })
        .eq("id", jobId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Retry queued — dispatcher picks up next tick");
      queryClient.invalidateQueries({ queryKey: ["autopost", "run-jobs", id] });
    },
    onError: (e: Error) => {
      toast.error(`Retry failed: ${e.message}`);
    },
  });

  const renderedVideoUrl = useMemo(() => {
    const r = videoJobQuery.data?.result?.finalUrl;
    const p = videoJobQuery.data?.payload?.finalUrl;
    return r || p || null;
  }, [videoJobQuery.data]);

  const projectId = useMemo(() => {
    const r = videoJobQuery.data?.result?.projectId;
    const p = videoJobQuery.data?.payload?.projectId;
    return r || p || null;
  }, [videoJobQuery.data]);

  const editorRoute = projectId ? `/app/editor/${projectId}` : null;

  const shortId = id ? `${id.slice(0, 8)}…` : "—";

  return (
    <LabLayout
      heading="Run detail"
      title="Run detail · Autopost · Lab"
      description="Full per-fire view: prompt, generation log, per-platform publish timeline, post URLs."
      breadcrumbs={[
        { label: "Autopost", to: "/lab/autopost" },
        { label: "Runs", to: "/lab/autopost/runs" },
        { label: shortId },
      ]}
    >
      <AutopostNav />

      {runQuery.isLoading ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 text-center text-[13px] text-[#8A9198]">
            Loading run…
          </CardContent>
        </Card>
      ) : !runQuery.data ? (
        <Card className="bg-[#10151A] border-white/8">
          <CardContent className="py-12 text-center text-[13px] text-[#E4C875]">
            Run not found (or you don't have access).
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Header */}
          <Card className="bg-[#10151A] border-white/8 mb-4">
            <CardContent className="py-5 sm:py-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
                {/* Thumbnail */}
                <div className="shrink-0 overflow-hidden rounded-md bg-black/40 border border-white/8 w-[120px] h-[213px] sm:w-[180px] sm:h-[320px]">
                  {runQuery.data.thumbnail_url ? (
                    <img
                      src={runQuery.data.thumbnail_url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[#5A6268]">
                      <ImageIcon className="h-6 w-6" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-3">
                  <div className="space-y-1.5">
                    <Link
                      to={`/lab/autopost/schedules/${runQuery.data.schedule_id}`}
                      className="font-serif text-xl text-[#ECEAE4] hover:text-[#11C4D0] transition-colors break-words"
                    >
                      {runQuery.data.schedule?.name ?? "(deleted schedule)"}
                    </Link>
                    <p className="text-[12px] text-[#8A9198]">
                      Fired {relativeTime(runQuery.data.fired_at)}{" "}
                      <span className="text-[#5A6268]">
                        ({new Date(runQuery.data.fired_at).toLocaleString()})
                      </span>
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill status={runQuery.data.status} />
                    {runQuery.data.topic && (
                      <span className="text-[12px] text-[#8A9198] truncate">
                        Topic: <span className="text-[#ECEAE4]">{runQuery.data.topic}</span>
                      </span>
                    )}
                  </div>

                  {runQuery.data.error_summary && (
                    <div className="rounded-md border border-[#E4C875]/30 bg-[#E4C875]/5 px-3 py-2">
                      <p className="text-[12px] text-[#E4C875]">{runQuery.data.error_summary}</p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    {renderedVideoUrl && (
                      <Button
                        size="sm"
                        asChild
                        className="bg-[#11C4D0] text-[#0A0D0F] hover:bg-[#11C4D0]/90"
                      >
                        <a href={renderedVideoUrl} target="_blank" rel="noreferrer noopener">
                          <Play className="h-3.5 w-3.5 mr-1.5" />
                          Watch rendered video
                        </a>
                      </Button>
                    )}
                    {editorRoute && (
                      <Button
                        size="sm"
                        variant="outline"
                        asChild
                        className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
                      >
                        <Link to={editorRoute}>
                          <Pencil className="h-3.5 w-3.5 mr-1.5" />
                          Open in editor
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmDelete(true)}
                      disabled={deleteMutation.isPending}
                      className="border-[#E4C875]/30 bg-transparent text-[#E4C875] hover:bg-[#E4C875]/10"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      Delete run
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Generation */}
          <Card className="bg-[#10151A] border-white/8 mb-4">
            <CardHeader className="border-b border-white/8">
              <CardTitle className="text-[#ECEAE4] text-base">Generation</CardTitle>
              <CardDescription className="text-[#8A9198] mt-0.5">
                Resolved prompt and per-event log line for this run.
              </CardDescription>
            </CardHeader>
            <CardContent className="py-4 space-y-4">
              <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-white/8 bg-black/20 px-3 py-2 text-left text-[13px] text-[#ECEAE4] hover:border-white/15 transition-colors"
                  >
                    {promptOpen ? <ChevronDown className="h-4 w-4 text-[#8A9198]" /> : <ChevronRight className="h-4 w-4 text-[#8A9198]" />}
                    <span>Prompt resolved</span>
                    <span className="ml-auto text-[11px] text-[#5A6268]">
                      {runQuery.data.prompt_resolved.length} chars
                    </span>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2">
                  <pre className="rounded-md border border-white/8 bg-black/40 px-3 py-3 text-[12px] text-[#ECEAE4] whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {runQuery.data.prompt_resolved}
                  </pre>
                </CollapsibleContent>
              </Collapsible>

              <div>
                <p className="text-[11px] uppercase tracking-wide text-[#8A9198] mb-2">Log</p>
                {logsQuery.isLoading ? (
                  <p className="text-[12px] text-[#8A9198]">Loading log…</p>
                ) : (logsQuery.data?.length ?? 0) === 0 ? (
                  <p className="text-[12px] text-[#5A6268]">
                    No log entries yet. Worker writes to system_logs once it starts processing.
                  </p>
                ) : (
                  <ul className="rounded-md border border-white/8 bg-black/20 divide-y divide-white/5 max-h-72 overflow-y-auto">
                    {logsQuery.data!.map(log => (
                      <li key={log.id} className="px-3 py-2 text-[12px]">
                        <div className="flex items-baseline gap-2">
                          <span
                            className="font-mono text-[11px] shrink-0"
                            style={{
                              color:
                                log.category === "system_error" ? "#E4C875"
                                : log.category === "system_warning" ? "#E4C875"
                                : "#11C4D0",
                            }}
                          >
                            {new Date(log.created_at).toLocaleTimeString()}
                          </span>
                          <span className="text-[#ECEAE4] break-words">{log.message}</span>
                        </div>
                        <p className="text-[10px] text-[#5A6268] font-mono mt-0.5">{log.event_type}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Per-platform timeline */}
          <Card className="bg-[#10151A] border-white/8">
            <CardHeader className="border-b border-white/8">
              <CardTitle className="text-[#ECEAE4] text-base">Publish timeline</CardTitle>
              <CardDescription className="text-[#8A9198] mt-0.5">
                One panel per target account. Status progresses queued → uploading → processing → published.
              </CardDescription>
            </CardHeader>
            <CardContent className="py-5">
              {publishJobsQuery.isLoading ? (
                <p className="text-[13px] text-[#8A9198]">Loading publish jobs…</p>
              ) : (publishJobsQuery.data?.length ?? 0) === 0 ? (
                <p className="text-[13px] text-[#5A6268]">
                  No publish jobs were created for this run.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
                  {publishJobsQuery.data!.map(job => (
                    <PublishJobPanel
                      key={job.id}
                      job={job}
                      onRetry={() => retryMutation.mutate(job.id)}
                      retrying={retryMutation.isPending && retryMutation.variables === job.id}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="bg-[#10151A] border-white/10 text-[#ECEAE4]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#8A9198]">
              This removes the autopost history entry, its publish jobs, and its
              thumbnail. The rendered video itself stays in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
              disabled={deleteMutation.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-[#E4C875] text-[#0A0D0F] hover:bg-[#E4C875]/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </LabLayout>
  );
}

function PublishJobPanel({
  job,
  onRetry,
  retrying,
}: {
  job: PublishJobRow;
  onRetry: () => void;
  retrying: boolean;
}) {
  const Icon = platformIcon(job.platform);
  const failed = job.status === "failed" || job.status === "rejected";
  const [errOpen, setErrOpen] = useState(false);

  return (
    <div className="rounded-lg border border-white/8 bg-black/20 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 text-[#11C4D0] shrink-0" />
          <p className="text-[13px] font-medium text-[#ECEAE4] truncate">
            {platformLabel(job.platform)}
          </p>
          {job.social_account?.display_name && (
            <span className="text-[11px] text-[#5A6268] truncate">
              · {job.social_account.display_name}
            </span>
          )}
        </div>
        <PublishStatusPill status={job.status} />
      </div>

      <div className="space-y-1.5 text-[12px]">
        <Row label="Attempts" value={String(job.attempts)} />
        <Row
          label="Last attempt"
          value={job.last_attempt_at ? relativeTime(job.last_attempt_at) : "—"}
        />
        {job.scheduled_for && (
          <Row label="Next attempt" value={relativeTime(job.scheduled_for)} />
        )}
        {job.platform_post_id && (
          <Row label="Post ID" value={job.platform_post_id} mono />
        )}
      </div>

      {job.platform_post_url && (
        <a
          href={job.platform_post_url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-[12px] text-[#11C4D0] hover:underline"
        >
          View live post
          <ExternalLink className="h-3 w-3" />
        </a>
      )}

      {failed && (job.error_code || job.error_message) && (
        <Collapsible open={errOpen} onOpenChange={setErrOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-[#E4C875]/20 bg-[#E4C875]/5 px-2.5 py-1.5 text-left text-[12px] text-[#E4C875] hover:bg-[#E4C875]/10 transition-colors"
            >
              {errOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <span className="truncate">
                {job.error_code ?? "error"}
                {job.error_message ? `: ${truncate(job.error_message, 60)}` : ""}
              </span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <pre className="rounded-md border border-white/8 bg-black/40 px-2.5 py-2 text-[11px] text-[#E4C875] whitespace-pre-wrap break-words font-mono">
              {job.error_code ? `${job.error_code}\n\n` : ""}
              {job.error_message ?? ""}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      {failed && (
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={retrying}
          className="w-full border-white/10 bg-transparent text-[#ECEAE4] hover:bg-white/5"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
          {retrying ? "Queuing…" : "Retry publish"}
        </Button>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className="text-[#5A6268] shrink-0">{label}</span>
      <span className={`text-[#ECEAE4] truncate ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
