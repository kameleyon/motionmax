import { useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, TrendingUp, CreditCard, RefreshCw } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { subDays, format } from "date-fns";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface RevenueStats {
  totalRevenue: number;
  mrr: number;
  chargeCount: number;
  activeSubscriptions: number;
  revenueByDay: Array<{ date: string; amount: number }>;
}

type TimePeriod = "7d" | "30d" | "90d" | "1y" | "all";

export function AdminRevenue() {
  const { callAdminApi, isAdmin } = useAdminAuth();
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
      case "1y":
        startDate = subDays(now, 365);
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

  const { data, isLoading: loading, error: queryError, refetch } = useQuery({
    queryKey: ["admin-revenue-stats", period],
    queryFn: async () => {
      const { startDate, endDate } = getDateRange(period);
      const result = await callAdminApi("revenue_stats", { startDate, endDate });
      return result as RevenueStats;
    },
    enabled: isAdmin,
    staleTime: 60000, // Cache for 60 seconds
    refetchOnWindowFocus: false,
  });

  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load revenue stats") : null;

  const periodOptions: { value: TimePeriod; label: string }[] = [
    { value: "7d", label: "7 Days" },
    { value: "30d", label: "30 Days" },
    { value: "90d", label: "90 Days" },
    { value: "1y", label: "1 Year" },
    { value: "all", label: "All Time" },
  ];

  if (loading) {
    return <LoadingSpinner className="py-12" />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button onClick={() => refetch()} variant="outline">
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
          <h2 className="text-2xl font-bold">Revenue Analytics</h2>
          <p className="text-muted-foreground">Track earnings and subscription performance</p>
        </div>

        <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/30">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setPeriod(option.value)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                period === option.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Cards - All teal themed */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <DollarSign className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${data?.totalRevenue?.toFixed(2) || "0.00"}</div>
            <p className="text-xs text-muted-foreground">
              {data?.chargeCount || 0} charges
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monthly Recurring</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <TrendingUp className="h-4 w-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">${data?.mrr?.toFixed(2) || "0.00"}</div>
            <p className="text-xs text-muted-foreground">Active Stripe subs</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Subs</CardTitle>
            <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
              <CreditCard className="h-4 w-4 text-secondary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data?.activeSubscriptions || 0}</div>
            <p className="text-xs text-muted-foreground">Currently active</p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Per Charge</CardTitle>
            <div className="p-2 rounded-lg bg-[hsl(var(--gold))]/10 shadow-sm">
              <DollarSign className="h-4 w-4 text-[hsl(var(--gold))]" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${data?.chargeCount
                ? (data.totalRevenue / data.chargeCount).toFixed(2)
                : "0.00"
              }
            </div>
            <p className="text-xs text-muted-foreground">Avg transaction</p>
          </CardContent>
        </Card>
      </div>

      {/* Revenue Chart */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Revenue Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          {data?.revenueByDay && data.revenueByDay.length > 0 ? (
            <div className="h-[300px] sm:h-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.revenueByDay}>
                  <defs>
                    <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value) => format(new Date(value), "MMM d")}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis
                    tickFormatter={(value) => `$${value}`}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    width={45}
                  />
                  <Tooltip
                    formatter={(value: number) => [`$${value.toFixed(2)}`, "Revenue"]}
                    labelFormatter={(label) => format(new Date(label), "PPP")}
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="amount"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorRevenue)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[300px] sm:h-[400px] text-muted-foreground">
              No revenue data available for this period
            </div>
          )}
        </CardContent>
      </Card>

      {/* Revenue by Plan */}
      <PlanBreakdown />
    </div>
  );
}

/** Subscription count breakdown by plan tier */
function PlanBreakdown() {
  const { data: plans } = useQuery({
    queryKey: ["admin-plan-breakdown"],
    queryFn: async () => {
      const { data } = await supabase.from("subscriptions").select("plan_name, status").eq("status", "active");
      if (!data) return [];
      const counts: Record<string, number> = {};
      for (const sub of data) {
        const plan = sub.plan_name || "free";
        counts[plan] = (counts[plan] || 0) + 1;
      }
      return Object.entries(counts).map(([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count);
    },
    staleTime: 120000,
  });

  if (!plans || plans.length === 0) return null;

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="type-h4">Active Subscriptions by Plan</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={plans} layout="vertical" margin={{ left: 80 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} horizontal={false} />
              <XAxis type="number" fontSize={11} stroke="hsl(var(--muted-foreground))" />
              <YAxis type="category" dataKey="plan" fontSize={12} stroke="hsl(var(--muted-foreground))" className="capitalize" />
              <Tooltip
                formatter={(value: number) => [value, "Subscribers"]}
                contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
              />
              <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
