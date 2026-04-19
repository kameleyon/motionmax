import { createScopedLogger } from "@/lib/logger";
import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, DollarSign, Zap, RefreshCw } from "lucide-react";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { subDays, format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

const log = createScopedLogger("AdminMetrics");

interface PerformanceMetrics {
  avgTimeByType: {
    doc2video: number;
    cinematic: number;
    smartflow: number;
  };
  successRateByType: {
    doc2video: number;
    cinematic: number;
    smartflow: number;
  };
  costPerOperation: {
    script: number;
    audio: number;
    image: number;
    video: number;
    total: number;
  };
  errorTrends: Array<{
    date: string;
    errors: number;
    total: number;
    rate: number;
  }>;
  providerCosts: Array<{
    provider: string;
    cost: number;
    percentage: number;
  }>;
}

type TimePeriod = "7d" | "30d" | "90d";

export function AdminPerformanceMetrics() {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<TimePeriod>("30d");

  const fetchMetrics = useCallback(async () => {
    try {
      setLoading(true);

      const now = new Date();
      const daysAgo = period === "7d" ? 7 : period === "30d" ? 30 : 90;
      const startDate = subDays(now, daysAgo);

      // Fetch generations WITH project type (project_type lives on projects table, not generations)
      const { data: generations } = await supabase
        .from("generations")
        .select("*, projects(project_type)")
        .gte("created_at", startDate.toISOString());

      // Calculate metrics from generations
      const byType: Record<string, { total: number; completed: number; totalTime: number }> = {
        doc2video: { total: 0, completed: 0, totalTime: 0 },
        cinematic: { total: 0, completed: 0, totalTime: 0 },
        smartflow: { total: 0, completed: 0, totalTime: 0 },
      };

      type GenRow = { status: string; created_at: string; completed_at: string | null; projects: { project_type: string } | null };
      generations?.forEach((gen: GenRow) => {
        const projectType = gen.projects?.project_type || "doc2video";
        if (!byType[projectType]) return;

        byType[projectType].total++;
        if (gen.status === "complete") {
          byType[projectType].completed++;

          if (gen.created_at && gen.completed_at) {
            const start = new Date(gen.created_at).getTime();
            const end = new Date(gen.completed_at).getTime();
            byType[projectType].totalTime += (end - start) / 1000;
          }
        }
      });

      // Fetch costs from generation_costs table
      const { data: costsData } = await supabase
        .from("generation_costs")
        .select("*")
        .gte("created_at", startDate.toISOString());

      // Aggregate costs
      let totalOpenRouter = 0;
      let totalHypereal = 0;
      let totalReplicate = 0;
      let totalGoogleTts = 0;
      let totalCost = 0;

      type CostRow = { openrouter_cost: number | null; hypereal_cost: number | null; replicate_cost: number | null; google_tts_cost: number | null; total_cost: number | null };
      costsData?.forEach((cost: CostRow) => {
        totalOpenRouter += Number(cost.openrouter_cost) || 0;
        totalHypereal += Number(cost.hypereal_cost) || 0;
        totalReplicate += Number(cost.replicate_cost) || 0;
        totalGoogleTts += Number(cost.google_tts_cost) || 0;
        totalCost += Number(cost.total_cost) || 0;
      });

      // Calculate error trends by day
      const errorTrendsByDay: Record<string, { errors: number; total: number }> = {};
      generations?.forEach((gen: GenRow) => {
        const day = format(new Date(gen.created_at), "yyyy-MM-dd");
        if (!errorTrendsByDay[day]) {
          errorTrendsByDay[day] = { errors: 0, total: 0 };
        }
        errorTrendsByDay[day].total++;
        if (gen.status === "error") {
          errorTrendsByDay[day].errors++;
        }
      });

      // Calculate provider costs distribution
      const providerCosts = [
        { provider: "OpenRouter", cost: totalOpenRouter, percentage: 0 },
        { provider: "Hypereal", cost: totalHypereal, percentage: 0 },
        { provider: "Replicate", cost: totalReplicate, percentage: 0 },
        { provider: "Google TTS", cost: totalGoogleTts, percentage: 0 },
      ];

      // Calculate percentages
      providerCosts.forEach((p) => {
        p.percentage = totalCost > 0 ? (p.cost / totalCost) * 100 : 0;
      });

      const calculatedMetrics: PerformanceMetrics = {
        avgTimeByType: {
          doc2video:
            byType.doc2video.completed > 0
              ? byType.doc2video.totalTime / byType.doc2video.completed
              : 0,
          cinematic:
            byType.cinematic.completed > 0
              ? byType.cinematic.totalTime / byType.cinematic.completed
              : 0,
          smartflow:
            byType.smartflow.completed > 0
              ? byType.smartflow.totalTime / byType.smartflow.completed
              : 0,
        },
        successRateByType: {
          doc2video:
            byType.doc2video.total > 0
              ? (byType.doc2video.completed / byType.doc2video.total) * 100
              : 0,
          cinematic:
            byType.cinematic.total > 0
              ? (byType.cinematic.completed / byType.cinematic.total) * 100
              : 0,
          smartflow:
            byType.smartflow.total > 0
              ? (byType.smartflow.completed / byType.smartflow.total) * 100
              : 0,
        },
        costPerOperation: {
          script: totalOpenRouter / Math.max((generations?.length || 1), 1),
          audio: totalGoogleTts / Math.max((generations?.length || 1), 1),
          image: totalHypereal / Math.max((generations?.length || 1), 1),
          video: totalReplicate / Math.max((generations?.length || 1), 1),
          total: totalCost / Math.max((generations?.length || 1), 1),
        },
        errorTrends: Object.entries(errorTrendsByDay)
          .map(([date, stats]) => ({
            date,
            errors: stats.errors,
            total: stats.total,
            rate: (stats.errors / stats.total) * 100,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        providerCosts,
      };

      setMetrics(calculatedMetrics);

      setError(null);
    } catch (err) {
      log.error("Failed to fetch performance metrics:", err);
      setError(err instanceof Error ? err.message : "Failed to load performance metrics");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const periodOptions: { value: TimePeriod; label: string }[] = [
    { value: "7d", label: "7 Days" },
    { value: "30d", label: "30 Days" },
    { value: "90d", label: "90 Days" },
  ];

  const performanceByTypeData = metrics
    ? [
        {
          type: "Doc2Video",
          avgTime: metrics.avgTimeByType.doc2video,
          successRate: metrics.successRateByType.doc2video,
        },
        {
          type: "Cinematic",
          avgTime: metrics.avgTimeByType.cinematic,
          successRate: metrics.successRateByType.cinematic,
        },
        {
          type: "SmartFlow",
          avgTime: metrics.avgTimeByType.smartflow,
          successRate: metrics.successRateByType.smartflow,
        },
      ]
    : [];

  const costBreakdownData = metrics
    ? [
        { operation: "Script", cost: metrics.costPerOperation.script },
        { operation: "Audio", cost: metrics.costPerOperation.audio },
        { operation: "Image", cost: metrics.costPerOperation.image },
        { operation: "Video", cost: metrics.costPerOperation.video },
      ]
    : [];

  if (loading) {
    return <AdminLoadingState />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={fetchMetrics} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No performance metrics available</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-2xl font-bold">Performance Metrics</h2>
          <p className="text-muted-foreground">Generation performance and cost analytics</p>
        </div>

        <div className="flex gap-2">
          {periodOptions.map((option) => (
            <Button
              key={option.value}
              variant={period === option.value ? "default" : "outline"}
              size="sm"
              onClick={() => setPeriod(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Average Time by Type */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Average Generation Time by Project Type
          </CardTitle>
          <CardDescription>Processing time from start to completion</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={performanceByTypeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis
                  dataKey="type"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={(value) => formatDuration(value)}
                />
                <Tooltip
                  formatter={(value: number) => formatDuration(value)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Bar
                  dataKey="avgTime"
                  name="Avg Time"
                  fill="hsl(var(--primary))"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={80}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Success Rate by Type */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Success Rate by Project Type
          </CardTitle>
          <CardDescription>Percentage of successful completions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {performanceByTypeData.map((item) => (
              <div key={item.type} className="p-4 rounded-lg bg-card border border-border/50">
                <div className="text-xs text-muted-foreground mb-2">{item.type}</div>
                <div className={`text-2xl font-semibold ${item.successRate >= 90 ? "text-primary" : item.successRate >= 70 ? "text-warning" : "text-destructive"}`}>
                  {item.successRate.toFixed(1)}%
                </div>
                {/* Visual bar */}
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${item.successRate >= 90 ? "bg-primary" : item.successRate >= 70 ? "bg-warning" : "bg-destructive"}`}
                    style={{ width: `${Math.min(item.successRate, 100)}%` }}
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-1.5">
                  {formatDuration(item.avgTime)} avg
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Cost per Operation Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-primary" />
            Cost per Operation Breakdown
          </CardTitle>
          <CardDescription>Average cost breakdown per generation</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={costBreakdownData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis
                    type="number"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(value) => formatCurrency(value)}
                  />
                  <YAxis
                    type="category"
                    dataKey="operation"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    width={80}
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar
                    dataKey="cost"
                    name="Cost"
                    fill="hsl(var(--primary))"
                    radius={[0, 4, 4, 0]}
                    maxBarSize={40}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="border-t pt-4">
              <div className="flex justify-between items-center text-lg font-semibold">
                <span>Average Total Cost per Generation</span>
                <span className="text-primary">{formatCurrency(metrics.costPerOperation.total)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Provider Cost Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-primary" />
            Cost Distribution by Provider
          </CardTitle>
          <CardDescription>Spending breakdown across API providers</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {metrics.providerCosts.map((provider) => (
              <div key={provider.provider} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{provider.provider}</span>
                  <span className="text-muted-foreground">
                    {formatCurrency(provider.cost)} ({provider.percentage}%)
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${provider.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Error Rate Trends */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-destructive" />
            Error Rate Trends
          </CardTitle>
          <CardDescription>Daily error rates over selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={metrics.errorTrends}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => format(new Date(value), "MMM d")}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickFormatter={(value) => `${value}%`}
                />
                <Tooltip
                  labelFormatter={(label) => format(new Date(label), "PPP")}
                  formatter={(value: number, name: string) => {
                    if (name === "Error Rate") return `${value.toFixed(1)}%`;
                    return value;
                  }}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="rate"
                  name="Error Rate"
                  stroke="hsl(var(--destructive))"
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--destructive))", strokeWidth: 2, r: 4 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
