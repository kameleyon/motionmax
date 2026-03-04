import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Loader2, Activity, CheckCircle, XCircle, Trash2, Clock, RefreshCw } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from "recharts";
import { subDays, format } from "date-fns";

interface GenerationStats {
  total: number;
  byStatus: {
    pending: number;
    processing: number;
    complete: number;
    error: number;
    deleted: number;
  };
  byDay: Array<{
    date: string;
    total: number;
    completed: number;
    failed: number;
    deleted: number;
  }>;
}

type TimePeriod = "7d" | "30d" | "90d" | "all";

// Teal-based color palette
const STATUS_COLORS = {
  pending: "hsl(170, 40%, 55%)", // Muted teal
  processing: "hsl(170, 55%, 45%)", // Medium teal
  complete: "hsl(170, 55%, 54%)", // Primary teal #49cdbf
  error: "hsl(0, 70%, 55%)", // Keep red for errors for visibility
  deleted: "hsl(200, 8%, 50%)", // Neutral gray
};

export function AdminGenerations() {
  const { callAdminApi } = useAdminAuth();
  const [data, setData] = useState<GenerationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<TimePeriod>("30d");

  const getDateRange = useCallback((p: TimePeriod) => {
    const now = new Date();
    let startDate: Date;
    
    switch (p) {
      case "7d":
        startDate = subDays(now, 7);
        break;
      case "30d":
        startDate = subDays(now, 30);
        break;
      case "90d":
        startDate = subDays(now, 90);
        break;
      case "all":
      default:
        return { startDate: undefined, endDate: undefined };
    }

    return {
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
    };
  }, []);

  const fetchGenerations = useCallback(async () => {
    try {
      setLoading(true);
      const { startDate, endDate } = getDateRange(period);
      const result = await callAdminApi("generation_stats", { startDate, endDate });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load generation stats");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, period, getDateRange]);

  useEffect(() => {
    fetchGenerations();
  }, [fetchGenerations]);

  const periodOptions: { value: TimePeriod; label: string }[] = [
    { value: "7d", label: "7 Days" },
    { value: "30d", label: "30 Days" },
    { value: "90d", label: "90 Days" },
    { value: "all", label: "All Time" },
  ];

  const pieData = data?.byStatus ? [
    { name: "Completed", value: data.byStatus.complete, color: STATUS_COLORS.complete },
    { name: "Processing", value: data.byStatus.processing, color: STATUS_COLORS.processing },
    { name: "Pending", value: data.byStatus.pending, color: STATUS_COLORS.pending },
    { name: "Failed", value: data.byStatus.error, color: STATUS_COLORS.error },
    { name: "Deleted", value: data.byStatus.deleted, color: STATUS_COLORS.deleted },
  ].filter(item => item.value > 0) : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={fetchGenerations} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div>
          <h2 className="text-2xl font-bold">Generation Analytics</h2>
          <p className="text-muted-foreground">Monitor video generation activity and performance</p>
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

      {/* Stats Cards - Teal themed */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Activity className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.total || 0}</div>
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
            <div className="text-2xl font-bold text-primary">{data?.byStatus?.complete || 0}</div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Processing</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Clock className="h-4 w-4 text-[hsl(170,55%,45%)]" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[hsl(170,55%,45%)]">
              {(data?.byStatus?.processing || 0) + (data?.byStatus?.pending || 0)}
            </div>
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
            <div className="text-2xl font-bold text-muted-foreground">{data?.byStatus?.error || 0}</div>
          </CardContent>
        </Card>

        <Card className="shadow-sm col-span-2 sm:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Deleted</CardTitle>
            <div className="p-2 rounded-lg bg-muted shadow-sm">
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-muted-foreground">{data?.byStatus?.deleted || 0}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Daily Chart - Elegant thin bars with rounded corners */}
        <Card className="lg:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle>Generations Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            {data?.byDay && data.byDay.length > 0 ? (
              <div className="h-[300px] sm:h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byDay} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(value) => format(new Date(value), "MMM d")}
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      width={35}
                    />
                    <Tooltip 
                      labelFormatter={(label) => format(new Date(label), "PPP")}
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar 
                      dataKey="completed" 
                      name="Completed" 
                      fill={STATUS_COLORS.complete} 
                      stackId="a" 
                      radius={[0, 0, 0, 0]}
                      maxBarSize={16}
                    />
                    <Bar 
                      dataKey="failed" 
                      name="Failed" 
                      fill={STATUS_COLORS.error} 
                      stackId="a" 
                      radius={[0, 0, 0, 0]}
                      maxBarSize={16}
                    />
                    <Bar 
                      dataKey="deleted" 
                      name="Deleted" 
                      fill={STATUS_COLORS.deleted} 
                      stackId="a" 
                      radius={[3, 3, 0, 0]}
                      maxBarSize={16}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[300px] sm:h-[350px] text-muted-foreground">
                No generation data available for this period
              </div>
            )}
          </CardContent>
        </Card>

        {/* Status Distribution */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Status Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length > 0 ? (
              <div className="h-[300px] sm:h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                      strokeWidth={0}
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                      labelLine={false}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[300px] sm:h-[350px] text-muted-foreground">
                No data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Success Rate - Teal themed */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Performance Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-3">
            <div className="text-center p-4 rounded-lg bg-card border border-primary/20 shadow-sm">
              <div className="text-2xl sm:text-3xl font-bold text-primary">
                {data?.total 
                  ? (((data.byStatus?.complete || 0) / (data.total - (data.byStatus?.deleted || 0))) * 100).toFixed(1)
                  : 0
                }%
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Success Rate</p>
            </div>
            <div className="text-center p-4 rounded-lg bg-card border shadow-sm">
              <div className="text-2xl sm:text-3xl font-bold text-muted-foreground">
                {data?.total 
                  ? (((data.byStatus?.error || 0) / (data.total - (data.byStatus?.deleted || 0))) * 100).toFixed(1)
                  : 0
                }%
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Failure Rate</p>
            </div>
            <div className="text-center p-4 rounded-lg bg-card border border-border shadow-sm">
              <div className="text-2xl sm:text-3xl font-bold text-muted-foreground">
                {data?.total 
                  ? (((data.byStatus?.deleted || 0) / data.total) * 100).toFixed(1)
                  : 0
                }%
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Deletion Rate</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
