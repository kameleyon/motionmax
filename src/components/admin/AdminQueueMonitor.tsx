import { createScopedLogger } from "@/lib/logger";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import {
  Loader2,
  Clock,
  CheckCircle,
  XCircle,
  Play,
  Pause,
  Activity,
  TrendingUp,
  AlertTriangle
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

const log = createScopedLogger("AdminQueue");

interface QueueJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  phase: string;
  progress: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  user_id: string;
  project_id: string | null;
  payload: Record<string, unknown>;
}

interface QueueStats {
  pending: number;
  processing: number;
  completed_24h: number;
  failed_24h: number;
  avgProcessingTime: number;
  estimatedWaitTime: number;
}

export function AdminQueueMonitor() {
  const { isAdmin } = useAdminAuth();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [stats, setStats] = useState<QueueStats>({
    pending: 0,
    processing: 0,
    completed_24h: 0,
    failed_24h: 0,
    avgProcessingTime: 0,
    estimatedWaitTime: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;

    const fetchQueueData = async () => {
      try {
        setLoading(true);

        // Fetch active jobs (pending or processing)
        const { data: activeJobs, error: jobsError } = await supabase
          .from("video_generation_jobs")
          .select("*")
          .in("status", ["pending", "processing"])
          .order("created_at", { ascending: true })
          .limit(50);

        if (jobsError) throw jobsError;

        setJobs((activeJobs as any as QueueJob[]) || []);

        // Calculate stats
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Get completed jobs in last 24h
        const { count: completedCount } = await supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "completed")
          .gte("completed_at", yesterday.toISOString());

        // Get failed jobs in last 24h
        const { count: failedCount } = await supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("completed_at", yesterday.toISOString());

        // Get recent completed jobs to calculate avg processing time
        const { data: recentCompleted } = await supabase
          .from("video_generation_jobs")
          .select("created_at, completed_at")
          .eq("status", "completed")
          .not("completed_at", "is", null)
          .gte("completed_at", yesterday.toISOString())
          .limit(100);

        let avgTime = 0;
        if (recentCompleted && recentCompleted.length > 0) {
          const times = recentCompleted.map((job: any) => {
            const start = new Date(job.created_at).getTime();
            const end = new Date(job.completed_at!).getTime();
            return (end - start) / 1000; // seconds
          });
          avgTime = times.reduce((a, b) => a + b, 0) / times.length;
        }

        const pendingCount = activeJobs?.filter((j) => j.status === "pending").length || 0;
        const processingCount = activeJobs?.filter((j) => j.status === "processing").length || 0;
        const estimatedWait = avgTime > 0 ? avgTime * pendingCount : 0;

        setStats({
          pending: pendingCount,
          processing: processingCount,
          completed_24h: completedCount || 0,
          failed_24h: failedCount || 0,
          avgProcessingTime: avgTime,
          estimatedWaitTime: estimatedWait,
        });

        setError(null);
      } catch (err) {
        log.error("Failed to fetch queue data:", err);
        setError(err instanceof Error ? err.message : "Failed to load queue data");
      } finally {
        setLoading(false);
      }
    };

    fetchQueueData();

    // Set up real-time subscription
    let channel: RealtimeChannel;

    const setupSubscription = async () => {
      channel = supabase
        .channel("admin-queue-monitor")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "video_generation_jobs",
          },
          () => {
            // Refetch data when jobs table changes
            fetchQueueData();
          }
        )
        .subscribe();
    };

    setupSubscription();

    // Refresh every 10 seconds as fallback
    const interval = setInterval(fetchQueueData, 10000);

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
      clearInterval(interval);
    };
  }, [isAdmin]);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending":
        return <Clock className="h-4 w-4" />;
      case "processing":
        return <Play className="h-4 w-4" />;
      case "completed":
        return <CheckCircle className="h-4 w-4" />;
      case "failed":
        return <XCircle className="h-4 w-4" />;
      default:
        return <Pause className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-muted text-muted-foreground";
      case "processing":
        return "bg-primary/10 text-primary";
      case "completed":
        return "bg-primary/10 text-primary";
      case "failed":
        return "bg-destructive/10 text-destructive";
      default:
        return "bg-muted text-muted-foreground";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  const hasHighLoad = stats.pending > 10 || stats.estimatedWaitTime > 300;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Queue Monitor</h2>
        <p className="text-muted-foreground">Real-time job queue and processing status</p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-6">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending</CardTitle>
            <div className="p-2 rounded-lg bg-muted shadow-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pending}</div>
            <CardDescription className="text-xs">In queue</CardDescription>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processing</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Play className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{stats.processing}</div>
            <CardDescription className="text-xs">Active now</CardDescription>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <CheckCircle className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">{stats.completed_24h}</div>
            <CardDescription className="text-xs">Last 24h</CardDescription>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <div className="p-2 rounded-lg bg-muted shadow-sm">
              <XCircle className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{stats.failed_24h}</div>
            <CardDescription className="text-xs">Last 24h</CardDescription>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Time</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Activity className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(stats.avgProcessingTime)}</div>
            <CardDescription className="text-xs">Per job</CardDescription>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Est. Wait</CardTitle>
            <div className={`p-2 rounded-lg shadow-sm ${hasHighLoad ? "bg-destructive/10" : "bg-muted"}`}>
              {hasHighLoad ? (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              ) : (
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${hasHighLoad ? "text-destructive" : ""}`}>
              {formatDuration(stats.estimatedWaitTime)}
            </div>
            <CardDescription className="text-xs">For new jobs</CardDescription>
          </CardContent>
        </Card>
      </div>

      {/* Active Jobs List */}
      <Card>
        <CardHeader>
          <CardTitle>Active Jobs</CardTitle>
          <CardDescription>
            Currently processing and queued jobs ({jobs.length} total)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No active jobs in the queue</p>
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center gap-4 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <Badge className={getStatusColor(job.status)} variant="outline">
                    <div className="flex items-center gap-1">
                      {getStatusIcon(job.status)}
                      <span className="text-xs">{job.status}</span>
                    </div>
                  </Badge>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {(job as any).task_type?.replace(/_/g, " ") || job.phase || "Initializing"}
                      </span>
                      {job.status === "processing" && (
                        <span className="text-xs text-muted-foreground">
                          {job.progress}%
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>ID: {job.id.slice(0, 8)}</span>
                      {job.user_id && <span>User: {job.user_id.slice(0, 8)}</span>}
                      {job.project_id && <span>Project: {job.project_id.slice(0, 8)}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="text-xs text-muted-foreground text-right">
                      <div>
                        Created {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
                      </div>
                      {job.started_at && (
                        <div className="text-primary">
                          Started {formatDistanceToNow(new Date(job.started_at), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        await supabase.from("video_generation_jobs").update({ status: "failed", error_message: "Cancelled by admin" }).eq("id", job.id);
                        // Refresh after cancel
                        window.location.reload();
                      }}
                      aria-label="Cancel job"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Success Rate Card */}
      <Card>
        <CardHeader>
          <CardTitle>Success Rate (24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-muted-foreground">Success</span>
                <span className="font-medium text-primary">
                  {stats.completed_24h + stats.failed_24h > 0
                    ? ((stats.completed_24h / (stats.completed_24h + stats.failed_24h)) * 100).toFixed(1)
                    : 0}%
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${
                      stats.completed_24h + stats.failed_24h > 0
                        ? (stats.completed_24h / (stats.completed_24h + stats.failed_24h)) * 100
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">{stats.completed_24h}</div>
              <div className="text-xs text-muted-foreground">Completed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-muted-foreground">{stats.failed_24h}</div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
