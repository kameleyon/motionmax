import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useQuery } from "@tanstack/react-query";
import { Users, CreditCard, Activity, Flag, Coins, Archive, Loader2, TrendingUp, TrendingDown, DollarSign, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface CostBreakdown {
  openrouter: number;
  replicate: number;
  hypereal: number;
  googleTts: number;
  total: number;
}

interface RevenueBreakdown {
  total: number;
  subscriptions: number;
  creditPacks: number;
}

interface DashboardStats {
  totalUsers: number;
  subscriberCount: number;
  activeSubscriptions: number;
  totalGenerations: number;
  activeGenerations: number;
  archivedGenerations: number;
  activeFlags: number;
  creditPurchases: number;
  costs: CostBreakdown;
  revenue: RevenueBreakdown;
  profitMargin: number;
}

interface TrendData {
  usersThisWeek: number;
  generationsThisWeek: number;
  revenueThisWeek: number;
}

export function AdminOverview() {
  const { callAdminApi, isAdmin } = useAdminAuth();

  const { data: stats, isLoading: loading, error: queryError } = useQuery({
    queryKey: ["admin-dashboard-stats"],
    queryFn: async () => {
      const data = await callAdminApi("dashboard_stats");
      return data as DashboardStats;
    },
    enabled: isAdmin,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  // Fetch trend data: counts from last 7 days
  const { data: trends } = useQuery({
    queryKey: ["admin-trends"],
    queryFn: async () => {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [usersRes, gensRes, revenueRes] = await Promise.all([
        supabase.from("profiles").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
        supabase.from("generations").select("*", { count: "exact", head: true }).gte("created_at", weekAgo),
        supabase.from("credit_transactions").select("amount").eq("transaction_type", "purchase").gte("created_at", weekAgo),
      ]);

      const revenueThisWeek = (revenueRes.data || []).reduce((sum, t) => sum + Math.abs(t.amount || 0), 0);

      return {
        usersThisWeek: usersRes.count || 0,
        generationsThisWeek: gensRes.count || 0,
        revenueThisWeek,
      } as TrendData;
    },
    enabled: isAdmin,
    staleTime: 120000,
  });

  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load stats") : null;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="h-6 w-48 rounded bg-muted animate-pulse" />
          <div className="h-4 w-64 rounded bg-muted animate-pulse" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="rounded-xl border border-border/50 p-6 space-y-3">
              <div className="flex justify-between">
                <div className="h-4 w-24 rounded bg-muted animate-pulse" />
                <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
              </div>
              <div className="h-7 w-16 rounded bg-muted animate-pulse" />
              <div className="h-3 w-32 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-3">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="gap-1.5">
          <ArrowUpRight className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  const formatCurrency = (amount: number) => `$${amount.toFixed(2)}`;

  const profitMargin = stats?.profitMargin || 0;
  const profitColor = profitMargin >= 0 ? "text-primary" : "text-destructive";

  const statCards = [
    {
      title: "Total Users",
      value: stats?.totalUsers || 0,
      description: "Registered accounts",
      icon: Users,
      color: "text-primary",
      bgColor: "bg-primary/10",
      trend: trends?.usersThisWeek,
      trendLabel: "this week",
    },
    {
      title: "Active Subscribers",
      value: stats?.subscriberCount || 0,
      description: "Paid subscriptions",
      icon: CreditCard,
      color: "text-secondary",
      bgColor: "bg-primary/10",
    },
    {
      title: "Total Generations",
      value: stats?.totalGenerations || 0,
      description: `${stats?.activeGenerations || 0} active`,
      icon: Activity,
      color: "text-primary",
      bgColor: "bg-primary/10",
      trend: trends?.generationsThisWeek,
      trendLabel: "this week",
    },
    {
      title: "Active Flags",
      value: stats?.activeFlags || 0,
      description: "Unresolved issues",
      icon: Flag,
      color: stats?.activeFlags ? "text-warning" : "text-muted-foreground",
      bgColor: stats?.activeFlags ? "bg-warning/10" : "bg-muted",
    },
    {
      title: "Credit Purchases",
      value: stats?.creditPurchases || 0,
      description: "Total transactions",
      icon: Coins,
      color: "text-[hsl(var(--gold))]",
      bgColor: "bg-[hsl(var(--gold))]/10",
    },
    {
      title: "Archived",
      value: stats?.archivedGenerations || 0,
      description: "Deleted by users",
      icon: Archive,
      color: "text-muted-foreground",
      bgColor: "bg-muted",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-h2 text-foreground">Dashboard Overview</h2>
        <p className="text-sm text-muted-foreground">Real-time platform statistics</p>
      </div>

      {/* 2.3 — Consistent grid: sm:grid-cols-2 lg:grid-cols-3 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {statCards.map((stat) => (
          <Card key={stat.title} className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{stat.value.toLocaleString()}</div>
              <div className="flex items-center justify-between mt-1">
                <CardDescription>{stat.description}</CardDescription>
                {/* 2.1 — Trend indicator */}
                {stat.trend !== undefined && stat.trend > 0 && (
                  <span className="flex items-center gap-0.5 text-xs text-primary">
                    <ArrowUpRight className="h-3 w-3" />
                    +{stat.trend} {stat.trendLabel}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Financial Overview — 2.3 consistent grid */}
      <div>
        <h3 className="type-h3 text-foreground mb-4">Financial Overview</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="shadow-sm border-primary/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <div className="p-2 rounded-lg bg-primary/10">
                <TrendingUp className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-primary">{formatCurrency(stats?.revenue?.total || 0)}</div>
              <div className="flex items-center justify-between mt-1">
                <CardDescription>All-time earnings</CardDescription>
                {trends && trends.revenueThisWeek > 0 && (
                  <span className="flex items-center gap-0.5 text-xs text-primary">
                    <ArrowUpRight className="h-3 w-3" />
                    +${trends.revenueThisWeek.toFixed(0)} this week
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm border-destructive/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
              <div className="p-2 rounded-lg bg-destructive/10">
                <TrendingDown className="h-4 w-4 text-destructive" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold text-destructive">{formatCurrency(stats?.costs?.total || 0)}</div>
              <CardDescription>API costs</CardDescription>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
              <div className={`p-2 rounded-lg ${profitMargin >= 0 ? "bg-primary/10" : "bg-destructive/10"}`}>
                <DollarSign className={`h-4 w-4 ${profitColor}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${profitColor}`}>
                {profitMargin >= 0 ? "+" : ""}{formatCurrency(profitMargin)}
              </div>
              <CardDescription>Revenue - Costs</CardDescription>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Revenue & Cost Breakdown */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="type-h4 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Revenue Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Subscriptions</span>
                <span className="text-sm font-medium text-primary">{formatCurrency(stats?.revenue?.subscriptions || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Credit Packs</span>
                <span className="text-sm font-medium text-primary">{formatCurrency(stats?.revenue?.creditPacks || 0)}</span>
              </div>
              <div className="border-t pt-3 flex justify-between items-center">
                <span className="text-sm font-medium">Total Revenue</span>
                <span className="text-sm font-semibold text-primary">{formatCurrency(stats?.revenue?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="type-h4 flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-destructive" />
              Cost Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">OpenRouter (LLM)</span>
                <span className="text-sm font-medium">{formatCurrency(stats?.costs?.openrouter || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Hypereal (Images/Video)</span>
                <span className="text-sm font-medium">{formatCurrency(stats?.costs?.hypereal || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Replicate (TTS)</span>
                <span className="text-sm font-medium">{formatCurrency(stats?.costs?.replicate || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Google TTS</span>
                <span className="text-sm font-medium">{formatCurrency(stats?.costs?.googleTts || 0)}</span>
              </div>
              <div className="border-t pt-3 flex justify-between items-center">
                <span className="text-sm font-medium">Total Spent</span>
                <span className="text-sm font-semibold text-destructive">{formatCurrency(stats?.costs?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
