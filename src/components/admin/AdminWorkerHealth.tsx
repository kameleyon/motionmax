import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Server, Cpu, HardDrive, Clock, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDistanceToNow, subHours, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

interface WorkerHealth {
  status: "healthy" | "warning" | "error" | "offline";
  uptime: number;
  lastHeartbeat: string;
  activeJobs: number;
  maxConcurrency: number;
  memoryUsage: number;
  cpuUsage: number;
  jobsProcessed24h: number;
  avgJobDuration: number;
  errorRate: number;
}

export function AdminWorkerHealth() {
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchWorkerHealth = async () => {
      try {
        setLoading(true);

        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // Get active jobs count
        const { count: activeCount } = await supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "processing");

        // Get completed jobs in last 24h
        const { count: completedCount } = await supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "complete")
          .gte("completed_at", yesterday.toISOString());

        // Get failed jobs in last 24h
        const { count: failedCount } = await supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "error")
          .gte("completed_at", yesterday.toISOString());

        // Get recent completed jobs for avg duration
        const { data: recentJobs } = await supabase
          .from("video_generation_jobs")
          .select("created_at, completed_at")
          .eq("status", "complete")
          .not("completed_at", "is", null)
          .gte("completed_at", yesterday.toISOString())
          .limit(100);

        let avgDuration = 0;
        if (recentJobs && recentJobs.length > 0) {
          const durations = recentJobs.map((job) => {
            const start = new Date(job.created_at).getTime();
            const end = new Date(job.completed_at!).getTime();
            return (end - start) / 1000; // seconds
          });
          avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        }

        // Check for recent activity (last 5 minutes)
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
        const { data: recentActivity } = await supabase
          .from("video_generation_jobs")
          .select("completed_at, status")
          .or(`completed_at.gte.${fiveMinutesAgo.toISOString()},status.eq.processing`)
          .limit(1);

        const isActive = recentActivity && recentActivity.length > 0;
        const lastActivity = recentActivity?.[0]?.completed_at
          ? new Date(recentActivity[0].completed_at)
          : new Date();

        // Calculate error rate
        const totalJobs = (completedCount || 0) + (failedCount || 0);
        const errorRate = totalJobs > 0 ? (failedCount || 0) / totalJobs : 0;

        // Determine health status
        let status: WorkerHealth["status"] = "healthy";
        if (!isActive) {
          status = "offline";
        } else if (errorRate > 0.2) {
          status = "error";
        } else if (errorRate > 0.1 || (activeCount || 0) > 5) {
          status = "warning";
        }

        // Calculate uptime from the oldest recent job
        const oldestJob = recentActivity?.[0];
        let uptimeSeconds = 0;
        if (oldestJob?.created_at) {
          uptimeSeconds = (now.getTime() - new Date(oldestJob.created_at).getTime()) / 1000;
        }

        setHealth({
          status,
          uptime: uptimeSeconds,
          lastHeartbeat: lastActivity.toISOString(),
          activeJobs: activeCount || 0,
          maxConcurrency: 6, // from worker MAX_CONCURRENT_JOBS
          memoryUsage: 0, // Not available without worker instrumentation
          cpuUsage: 0, // Not available without worker instrumentation
          jobsProcessed24h: completedCount || 0,
          avgJobDuration: avgDuration,
          errorRate: errorRate * 100, // convert to percentage
        });

        setError(null);
      } catch (err) {
        console.error("Failed to fetch worker health:", err);
        setError(err instanceof Error ? err.message : "Failed to load worker health");
      } finally {
        setLoading(false);
      }
    };

    fetchWorkerHealth();

    // Refresh every 15 seconds
    const interval = setInterval(fetchWorkerHealth, 15000);

    return () => clearInterval(interval);
  }, []);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const hours = Math.floor(seconds / 3600);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    return `${hours}h`;
  };

  const getHealthIcon = (status: string) => {
    switch (status) {
      case "healthy":
        return <CheckCircle className="h-5 w-5 text-primary" />;
      case "warning":
        return <AlertTriangle className="h-5 w-5 text-[hsl(var(--warning))]" />;
      case "error":
        return <XCircle className="h-5 w-5 text-destructive" />;
      case "offline":
        return <Server className="h-5 w-5 text-muted-foreground" />;
      default:
        return <Server className="h-5 w-5" />;
    }
  };

  const getHealthColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "bg-primary/10 text-primary border-primary/20";
      case "warning":
        return "bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))] border-[hsl(var(--warning))]/20";
      case "error":
        return "bg-destructive/10 text-destructive border-destructive/20";
      case "offline":
        return "bg-muted text-muted-foreground border-border";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  const getHealthLabel = (status: string) => {
    switch (status) {
      case "healthy":
        return "Healthy";
      case "warning":
        return "Warning";
      case "error":
        return "Error";
      case "offline":
        return "Offline";
      default:
        return "Unknown";
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

  if (!health) {
    return (
      <EmptyState
        icon={Server}
        title="No worker health data"
        description="Worker health information will appear once the worker is connected."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Worker Health</h2>
        <p className="text-muted-foreground">Monitor worker status and performance</p>
      </div>

      {/* Status Overview */}
      <Card className={`border-2 ${getHealthColor(health.status)}`}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {getHealthIcon(health.status)}
              <div>
                <CardTitle>Worker Status</CardTitle>
                <CardDescription>
                  Last heartbeat: {formatDistanceToNow(new Date(health.lastHeartbeat), { addSuffix: true })}
                </CardDescription>
              </div>
            </div>
            <Badge className={getHealthColor(health.status)} variant="outline">
              {getHealthLabel(health.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Uptime</div>
              <div className="text-2xl font-bold">{formatDuration(health.uptime)}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Active Jobs</div>
              <div className="text-2xl font-bold text-primary">
                {health.activeJobs} / {health.maxConcurrency}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Jobs Processed (24h)</div>
              <div className="text-2xl font-bold">{health.jobsProcessed24h}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Avg Job Duration</div>
              <div className="text-2xl font-bold">{formatDuration(health.avgJobDuration)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resource Usage - Hidden until worker instrumentation is added */}
      {(health.memoryUsage > 0 || health.cpuUsage > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {health.memoryUsage > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-primary" />
                  <CardTitle>Memory Usage</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Current</span>
                    <span className="font-medium">{health.memoryUsage.toFixed(1)}%</span>
                  </div>
                  <Progress value={health.memoryUsage} className="h-3" />
                  {health.memoryUsage > 80 && (
                    <p className="text-xs text-destructive mt-2">High memory usage detected</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {health.cpuUsage > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-primary" />
                  <CardTitle>CPU Usage</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Current</span>
                    <span className="font-medium">{health.cpuUsage.toFixed(1)}%</span>
                  </div>
                  <Progress value={health.cpuUsage} className="h-3" />
                  {health.cpuUsage > 80 && (
                    <p className="text-xs text-destructive mt-2">High CPU usage detected</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Concurrency */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle>Job Concurrency</CardTitle>
          </div>
          <CardDescription>
            Active job slots vs maximum capacity
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">
                {health.activeJobs} active / {health.maxConcurrency} max
              </span>
              <span className="font-medium">
                {((health.activeJobs / health.maxConcurrency) * 100).toFixed(0)}% capacity
              </span>
            </div>
            <Progress value={(health.activeJobs / health.maxConcurrency) * 100} className="h-3" />
            {health.activeJobs >= health.maxConcurrency && (
              <p className="text-xs text-[hsl(var(--warning))] mt-2">
                Worker at maximum capacity - new jobs will queue
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error Rate */}
      <Card className={health.errorRate > 10 ? "border-destructive/50" : ""}>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>Error Rate (24h)</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Job failure rate</span>
              <span className={`font-medium ${health.errorRate > 10 ? "text-destructive" : ""}`}>
                {health.errorRate.toFixed(1)}%
              </span>
            </div>
            <Progress
              value={health.errorRate}
              className={`h-3 ${health.errorRate > 10 ? "[&>div]:bg-destructive" : ""}`}
            />
            {health.errorRate > 20 && (
              <p className="text-xs text-destructive mt-2">
                Critical error rate - investigate worker logs immediately
              </p>
            )}
            {health.errorRate > 10 && health.errorRate <= 20 && (
              <p className="text-xs text-[hsl(var(--warning))] mt-2">
                Elevated error rate - monitor closely
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Job Throughput Chart (24h) */}
      <ThroughputChart />
    </div>
  );
}

function ThroughputChart() {
  const { data: chartData } = useQuery({
    queryKey: ["worker-throughput-24h"],
    queryFn: async () => {
      const since = subHours(new Date(), 24).toISOString();
      const { data } = await supabase
        .from("video_generation_jobs")
        .select("created_at, status")
        .gte("created_at", since)
        .in("status", ["completed", "failed"])
        .order("created_at", { ascending: true });

      if (!data) return [];

      // Group by hour
      const hourly: Record<string, { hour: string; completed: number; failed: number }> = {};
      for (const job of data) {
        const h = format(new Date(job.created_at), "HH:00");
        if (!hourly[h]) hourly[h] = { hour: h, completed: 0, failed: 0 };
        if (job.status === "completed") hourly[h].completed++;
        else hourly[h].failed++;
      }
      return Object.values(hourly);
    },
    staleTime: 60000,
  });

  if (!chartData || chartData.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="type-h4">Job Throughput (24h)</CardTitle>
        <CardDescription>Completed vs failed jobs by hour</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <XAxis dataKey="hour" fontSize={10} stroke="hsl(var(--muted-foreground))" />
              <YAxis fontSize={10} stroke="hsl(var(--muted-foreground))" width={30} />
              <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }} />
              <Area type="monotone" dataKey="completed" stackId="1" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.3} />
              <Area type="monotone" dataKey="failed" stackId="1" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive))" fillOpacity={0.3} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
