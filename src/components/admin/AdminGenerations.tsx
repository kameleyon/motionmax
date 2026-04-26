import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Activity, CheckCircle, XCircle, Trash2, Clock, RefreshCw, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell } from "recharts";
import { subDays, format, formatDistanceToNow } from "date-fns";

interface GenerationRow {
  id: string;
  user_id: string;
  project_id: string | null;
  status: string;
  progress: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface GenerationListResult {
  rows: GenerationRow[];
  total: number;
  page: number;
  limit: number;
}

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

// Aqua-based color palette using design tokens
const STATUS_COLORS = {
  pending: "hsl(var(--muted-foreground))", // Muted
  processing: "hsl(var(--secondary))", // Light aqua
  complete: "hsl(var(--primary))", // Primary aqua #11C4D0
  error: "hsl(var(--destructive))", // Red for errors
  deleted: "hsl(var(--muted-foreground))", // Neutral gray
};

const LIST_PAGE_SIZE = 20;

const STATUS_BADGE: Record<string, string> = {
  complete: "bg-primary/15 text-primary",
  processing: "bg-secondary/20 text-secondary-foreground",
  pending: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

export function AdminGenerations() {
  const { callAdminApi } = useAdminAuth();
  const [data, setData] = useState<GenerationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<TimePeriod>("30d");

  const [listData, setListData] = useState<GenerationListResult | null>(null);
  const [listPage, setListPage] = useState(0);
  const [listStatus, setListStatus] = useState("all");
  const [listSearch, setListSearch] = useState("");
  const [listSearchInput, setListSearchInput] = useState("");
  const [listLoading, setListLoading] = useState(false);

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
      setData(result as typeof data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load generation stats");
    } finally {
      setLoading(false);
    }
  }, [callAdminApi, period, getDateRange]);

  const fetchGenerationList = useCallback(async () => {
    try {
      setListLoading(true);
      const result = await callAdminApi("generation_list", {
        page: listPage,
        limit: LIST_PAGE_SIZE,
        status: listStatus,
        search: listSearch || undefined,
      }) as GenerationListResult;
      setListData(result);
    } catch {
      // list errors are non-critical; charts are still shown
    } finally {
      setListLoading(false);
    }
  }, [callAdminApi, listPage, listStatus, listSearch]);

  useEffect(() => {
    fetchGenerations();
  }, [fetchGenerations]);

  useEffect(() => {
    fetchGenerationList();
  }, [fetchGenerationList]);

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
    return <AdminLoadingState />;
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
          <h2 className="font-serif text-[26px] font-medium">Generation Analytics</h2>
          <p className="text-muted-foreground">Monitor video generation activity and performance</p>
        </div>

        <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setPeriod(option.value)}
              className={cn(
                "px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors min-h-[36px]",
                period === option.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Cards - Teal themed */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Total</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Activity className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-serif text-[26px] font-medium">{data?.total || 0}</div>
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Completed</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <CheckCircle className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-serif text-[26px] font-medium text-primary">{data?.byStatus?.complete || 0}</div>
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Processing</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <Clock className="h-4 w-4 text-secondary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-serif text-[26px] font-medium text-secondary">
              {(data?.byStatus?.processing || 0) + (data?.byStatus?.pending || 0)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Failed</CardTitle>
            <div className="p-2 rounded-lg bg-muted shadow-sm">
              <XCircle className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-serif text-[26px] font-medium text-muted-foreground">{data?.byStatus?.error || 0}</div>
          </CardContent>
        </Card>

        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm col-span-2 sm:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium">Deleted</CardTitle>
            <div className="p-2 rounded-lg bg-muted shadow-sm">
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-serif text-[26px] font-medium text-muted-foreground">{data?.byStatus?.deleted || 0}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Daily Chart - Elegant thin bars with rounded corners */}
        <Card className="bg-[#10151A] border-white/8 shadow-none lg:col-span-2 shadow-sm">
          <CardHeader>
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Generations Over Time</CardTitle>
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
        <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
          <CardHeader>
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Status Distribution</CardTitle>
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
                      label={({ name, percent }) => percent > 0 ? `${name} ${(percent * 100).toFixed(0)}%` : ""}
                      labelLine={true}
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
      <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
        <CardHeader>
          <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Performance Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-3">
            <div className="text-center p-4 rounded-lg bg-card border border-primary/20 shadow-sm">
              <div className="text-2xl sm:font-serif text-[28px] font-medium text-primary">
                {data?.total
                  ? (((data.byStatus?.complete || 0) / (data.total - (data.byStatus?.deleted || 0))) * 100).toFixed(1)
                  : 0
                }%
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Success Rate</p>
            </div>
            <div className="text-center p-4 rounded-lg bg-card border shadow-sm">
              <div className="text-2xl sm:font-serif text-[28px] font-medium text-muted-foreground">
                {data?.total
                  ? (((data.byStatus?.error || 0) / (data.total - (data.byStatus?.deleted || 0))) * 100).toFixed(1)
                  : 0
                }%
              </div>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1">Failure Rate</p>
            </div>
            <div className="text-center p-4 rounded-lg bg-card border border-border shadow-sm">
              <div className="text-2xl sm:font-serif text-[28px] font-medium text-muted-foreground">
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

      {/* Individual Generations List */}
      <Card className="bg-[#10151A] border-white/8 shadow-none shadow-sm">
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4]">Individual Jobs</CardTitle>
            <div className="flex gap-2 flex-wrap">
              {["all", "complete", "processing", "pending", "error"].map(s => (
                <button
                  key={s}
                  onClick={() => { setListStatus(s); setListPage(0); }}
                  className={cn(
                    "px-3 py-2 text-[12px] font-medium rounded-md border transition-colors min-h-[36px]",
                    listStatus === s ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search by job ID or user ID…"
                value={listSearchInput}
                onChange={e => setListSearchInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { setListSearch(listSearchInput); setListPage(0); } }}
                className="pl-8 h-11 sm:h-8 text-base sm:text-xs"
              />
            </div>
            <Button size="sm" variant="outline" className="h-11 sm:h-8" onClick={() => { setListSearch(listSearchInput); setListPage(0); }}>
              Search
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {listLoading ? (
            <div className="flex items-center justify-center py-10">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : !listData?.rows.length ? (
            <p className="text-center text-sm text-muted-foreground py-10">No jobs found</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Job ID</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Progress</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Created</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Completed</th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {listData.rows.map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{row.id.slice(0, 8)}…</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{row.user_id.slice(0, 8)}…</td>
                      <td className="px-4 py-2.5">
                        <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", STATUS_BADGE[row.status] ?? "bg-muted text-muted-foreground")}>
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.progress}%</td>
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                        {row.completed_at ? formatDistanceToNow(new Date(row.completed_at), { addSuffix: true }) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-destructive max-w-[200px] truncate" title={row.error_message ?? ""}>
                        {row.error_message ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {listData && listData.total > LIST_PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <span className="text-xs text-muted-foreground">
                {listPage * LIST_PAGE_SIZE + 1}–{Math.min((listPage + 1) * LIST_PAGE_SIZE, listData.total)} of {listData.total}
              </span>
              <div className="flex gap-1">
                <Button size="icon" variant="outline" className="h-7 w-7" disabled={listPage === 0} onClick={() => setListPage(p => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="outline" className="h-7 w-7" disabled={(listPage + 1) * LIST_PAGE_SIZE >= listData.total} onClick={() => setListPage(p => p + 1)}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
