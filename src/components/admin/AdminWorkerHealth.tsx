import { createScopedLogger } from "@/lib/logger";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Server, Cpu, HardDrive, Clock, CheckCircle, AlertTriangle, XCircle, RefreshCw, Settings, Sparkles } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDistanceToNow, subHours, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";

const log = createScopedLogger("AdminWorkerHealth");

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
  // Concurrency override: null = use env / auto-tune; int = explicit override.
  const [concurrencyOverride, setConcurrencyOverride] = useState<number | null>(null);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [perWorker, setPerWorker] = useState<Array<{
    worker_id: string;
    completed: number;
    failed: number;
    avgDurationSec: number;
    lastSeen: string | null;
  }>>([]);

  const fetchWorkerHealth = useCallback(async () => {
    try {
      setLoading(true);

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Attempt to fetch real vitals from worker /health endpoint
      const workerUrl = import.meta.env.VITE_WORKER_URL as string | undefined;
      let liveVitals: {
        uptime: number;
        activeJobs: number;
        maxConcurrentJobs: number;
        lastPollAt: string | null;
        memoryUsage: number; // heap % (0-100)
        accepting: boolean;
      } | null = null;

      if (workerUrl) {
        try {
          const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const body = await res.json();
            const heapPct = body.memory?.heapTotalMb > 0
              ? (body.memory.heapUsedMb / body.memory.heapTotalMb) * 100
              : 0;
            liveVitals = {
              uptime: body.uptime ?? 0,
              activeJobs: body.worker?.activeJobs ?? 0,
              maxConcurrentJobs: body.worker?.maxConcurrentJobs ?? 6,
              lastPollAt: body.worker?.lastPollAt ?? null,
              memoryUsage: heapPct,
              accepting: body.worker?.accepting ?? true,
            };
          }
        } catch {
          log.warn("Worker /health unreachable — falling back to DB inference");
        }
      }

      // DB queries for 24h stats (always run — worker endpoint only has since-startup totals)
      const [
        { count: activeCount },
        { count: completedCount },
        { count: failedCount },
        { data: recentJobs },
        { data: recentActivity },
      ] = await Promise.all([
        supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "processing"),
        supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "completed")
          .gte("completed_at", yesterday.toISOString()),
        supabase
          .from("video_generation_jobs")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("completed_at", yesterday.toISOString()),
        supabase
          .from("video_generation_jobs")
          .select("created_at, completed_at")
          .eq("status", "completed")
          .not("completed_at", "is", null)
          .gte("completed_at", yesterday.toISOString())
          .limit(100),
        supabase
          .from("video_generation_jobs")
          .select("completed_at, status")
          .or(`completed_at.gte.${new Date(now.getTime() - 5 * 60 * 1000).toISOString()},status.eq.processing`)
          .limit(1),
      ]);

      let avgDuration = 0;
      if (recentJobs && recentJobs.length > 0) {
        const durations = recentJobs.map((job: { created_at: string; completed_at: string | null }) => {
          const start = new Date(job.created_at).getTime();
          const end = new Date(job.completed_at!).getTime();
          return (end - start) / 1000;
        });
        avgDuration = durations.reduce((a: number, b: number) => a + b, 0) / durations.length;
      }

      type ActivityRow = { completed_at: string | null };
      const recentActivityRows = recentActivity as ActivityRow[] | null;
      const isActive = (recentActivityRows && recentActivityRows.length > 0) || (liveVitals?.accepting ?? false);
      const lastActivity = liveVitals?.lastPollAt
        ? new Date(liveVitals.lastPollAt)
        : recentActivityRows?.[0]?.completed_at
          ? new Date(recentActivityRows[0].completed_at)
          : new Date();

      const totalJobs = (completedCount || 0) + (failedCount || 0);
      const errorRate = totalJobs > 0 ? (failedCount || 0) / totalJobs : 0;

      let status: WorkerHealth["status"] = "healthy";
      if (!isActive) {
        status = "offline";
      } else if (errorRate > 0.2) {
        status = "error";
      } else if (errorRate > 0.1 || (liveVitals?.activeJobs ?? activeCount ?? 0) > 5) {
        status = "warning";
      }

      // Use worker-reported uptime (accurate process uptime).
      // Fallback is 0 — not the oldest recent job, which was misleading.
      const uptimeSeconds = liveVitals?.uptime ?? 0;

      setHealth({
        status,
        uptime: uptimeSeconds,
        lastHeartbeat: lastActivity.toISOString(),
        activeJobs: liveVitals?.activeJobs ?? activeCount ?? 0,
        maxConcurrency: liveVitals?.maxConcurrentJobs ?? 6,
        memoryUsage: liveVitals?.memoryUsage ?? 0,
        cpuUsage: 0,
        jobsProcessed24h: completedCount || 0,
        avgJobDuration: avgDuration,
        errorRate: errorRate * 100,
      });

      setError(null);
    } catch (err) {
      log.error("Failed to fetch worker health:", err);
      setError(err instanceof Error ? err.message : "Failed to load worker health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkerHealth();
    const interval = setInterval(fetchWorkerHealth, 15000);
    return () => clearInterval(interval);
  }, [fetchWorkerHealth]);

  // Load the persisted concurrency override on mount.
  useEffect(() => {
    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await (supabase.rpc as any)("admin_get_app_setting", {
          setting_key: "worker_concurrency_override",
        });
        if (typeof data === "number" && data > 0) {
          setConcurrencyOverride(data);
          setOverrideEnabled(true);
        } else {
          setOverrideEnabled(false);
        }
      } catch {
        // Silent — slider just renders empty / null state.
      }
    })();
  }, []);

  // Per-worker latency aggregation. Groups recent completed jobs by
  // worker_id and computes count + avg duration so admins can spot a
  // single bad worker that's dragging the aggregate. With one worker
  // today this shows a single row — purpose is to scale out cleanly.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("video_generation_jobs")
        .select("worker_id, status, created_at, updated_at")
        .gte("created_at", since)
        .not("worker_id", "is", null)
        .in("status", ["completed", "failed"])
        .limit(2000);
      if (cancelled) return;
      const byWorker: Record<string, { completed: number; failed: number; durationsMs: number[]; lastSeen: string | null }> = {};
      for (const row of (data ?? []) as Array<{ worker_id: string | null; status: string; created_at: string; updated_at: string | null }>) {
        if (!row.worker_id) continue;
        const wid = row.worker_id;
        if (!byWorker[wid]) byWorker[wid] = { completed: 0, failed: 0, durationsMs: [], lastSeen: null };
        if (row.status === "completed") byWorker[wid].completed++;
        else if (row.status === "failed") byWorker[wid].failed++;
        if (row.created_at && row.updated_at) {
          const d = new Date(row.updated_at).getTime() - new Date(row.created_at).getTime();
          if (d > 0 && d < 24 * 60 * 60 * 1000) byWorker[wid].durationsMs.push(d);
        }
        if (!byWorker[wid].lastSeen || (row.updated_at && row.updated_at > byWorker[wid].lastSeen!)) {
          byWorker[wid].lastSeen = row.updated_at;
        }
      }
      const rows = Object.entries(byWorker).map(([worker_id, v]) => ({
        worker_id,
        completed: v.completed,
        failed: v.failed,
        avgDurationSec: v.durationsMs.length > 0
          ? v.durationsMs.reduce((a, b) => a + b, 0) / v.durationsMs.length / 1000
          : 0,
        lastSeen: v.lastSeen,
      })).sort((a, b) => b.completed + b.failed - (a.completed + a.failed));
      setPerWorker(rows);
    })();
    return () => { cancelled = true; };
  }, [health]); // re-aggregate after each main-card refresh

  const handleSaveOverride = async (value: number | null) => {
    setSavingOverride(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase.rpc as any)(
        "admin_set_worker_concurrency_override",
        { value: value ?? -1 }, // -1 → null (revert) per RPC contract
      );
      if (rpcError) throw rpcError;
      toast.success(value === null ? "Reverted to auto-tune" : `Concurrency override set to ${value}`);
    } catch (err) {
      toast.error("Failed to save", { description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSavingOverride(false);
    }
  };

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
    return <LoadingSpinner className="py-12" />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={fetchWorkerHealth} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
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
        <h2 className="font-serif text-[26px] font-medium">Worker Health</h2>
        <p className="text-muted-foreground">Monitor worker status and performance</p>
      </div>

      {/* Status Overview */}
      <Card className={`border-2 ${getHealthColor(health.status)}`}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {getHealthIcon(health.status)}
              <div>
                <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Worker Status</CardTitle>
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
              <div className="font-serif text-[26px] font-medium">{formatDuration(health.uptime)}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Active Jobs</div>
              <div className="font-serif text-[26px] font-medium text-primary">
                {health.activeJobs} / {health.maxConcurrency}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Jobs Processed (24h)</div>
              <div className="font-serif text-[26px] font-medium">{health.jobsProcessed24h}</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground mb-1">Avg Job Duration</div>
              <div className="font-serif text-[26px] font-medium">{formatDuration(health.avgJobDuration)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resource Usage - Hidden until worker instrumentation is added */}
      {(health.memoryUsage > 0 || health.cpuUsage > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {health.memoryUsage > 0 && (
            <Card className="bg-[#10151A] border-white/8 shadow-none">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-primary" />
                  <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Memory Usage</CardTitle>
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
            <Card className="bg-[#10151A] border-white/8 shadow-none">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-primary" />
                  <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">CPU Usage</CardTitle>
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
      <Card className="bg-[#10151A] border-white/8 shadow-none">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Job Concurrency</CardTitle>
          </div>
          <CardDescription>
            Active job slots vs maximum capacity
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
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

            {/* Runtime concurrency override. Toggle on enables manual slider;
                toggle off reverts the worker to env / auto-tune baseline.
                Worker polls app_settings every 60s to pick this up. */}
            <div className="pt-3 border-t border-white/8 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-primary" />
                  <Label className="text-sm font-medium">Override concurrency at runtime</Label>
                </div>
                <Switch
                  checked={overrideEnabled}
                  disabled={savingOverride}
                  onCheckedChange={(checked) => {
                    setOverrideEnabled(checked);
                    if (!checked) {
                      handleSaveOverride(null);
                      setConcurrencyOverride(null);
                    } else if (concurrencyOverride === null) {
                      setConcurrencyOverride(health.maxConcurrency || 8);
                    }
                  }}
                />
              </div>
              {overrideEnabled ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Manual cap (1–64). Worker picks up changes within 60s.</span>
                    <span className="font-mono font-medium text-primary">{concurrencyOverride ?? "—"} slots</span>
                  </div>
                  <Slider
                    min={1}
                    max={64}
                    step={1}
                    value={[concurrencyOverride ?? health.maxConcurrency ?? 8]}
                    onValueChange={(v) => setConcurrencyOverride(v[0] ?? null)}
                    onValueCommit={(v) => v[0] && handleSaveOverride(v[0])}
                    disabled={savingOverride}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                    <span>1</span><span>16</span><span>32</span><span>48</span><span>64</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" />
                  Auto-tune is on. Worker uses env (WORKER_CONCURRENCY) or CPU/RAM detection.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-worker latency breakdown — surfaces stats grouped by worker_id
          so admins can spot a single bad replica. With one worker today,
          the table has one row; designed to scale to N workers without
          additional schema changes. */}
      {perWorker.length > 0 && (
        <Card className="bg-[#10151A] border-white/8 shadow-none">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Per-Worker Latency (24h)</CardTitle>
            </div>
            <CardDescription>
              {perWorker.length === 1
                ? "Single worker — breakdown will scale automatically to multiple replicas."
                : `${perWorker.length} workers active in last 24h`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Worker ID</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Completed</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Failed</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Error %</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Avg Duration</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Last Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {perWorker.map((w) => {
                    const total = w.completed + w.failed;
                    const errPct = total > 0 ? (w.failed / total) * 100 : 0;
                    return (
                      <tr key={w.worker_id} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground" title={w.worker_id}>
                          {w.worker_id.slice(0, 24)}…
                        </td>
                        <td className="px-3 py-2 text-right text-primary font-medium">{w.completed}</td>
                        <td className="px-3 py-2 text-right text-destructive">{w.failed}</td>
                        <td className={`px-3 py-2 text-right ${errPct > 10 ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                          {errPct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {w.avgDurationSec > 0 ? `${w.avgDurationSec.toFixed(1)}s` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">
                          {w.lastSeen ? formatDistanceToNow(new Date(w.lastSeen), { addSuffix: true }) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Error Rate */}
      <Card className={health.errorRate > 10 ? "border-destructive/50" : ""}>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Error Rate (24h)</CardTitle>
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
  const { data: chartData, isFetching } = useQuery({
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
    staleTime: 30000,
    refetchInterval: 30000,
  });

  if (!chartData || chartData.length === 0) return null;

  return (
    <Card className="bg-[#10151A] border-white/8 shadow-none">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Job Throughput (24h)</CardTitle>
            <CardDescription>Completed vs failed jobs by hour</CardDescription>
          </div>
          <Badge
            variant="outline"
            aria-label={isFetching ? "Refreshing data" : "Live"}
            className="bg-primary/10 text-primary border-primary/30 gap-1.5 shrink-0"
          >
            <span
              className={`inline-block h-2 w-2 rounded-full bg-primary ${isFetching ? "animate-pulse" : ""}`}
            />
            LIVE
          </Badge>
        </div>
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
