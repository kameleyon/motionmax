import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useQuery } from "@tanstack/react-query";
import { Users, CreditCard, Activity, Flag, Coins, Archive, Loader2, TrendingUp, TrendingDown, DollarSign } from "lucide-react";

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

export function AdminOverview() {
  const { callAdminApi, isAdmin } = useAdminAuth();
  
  const { data: stats, isLoading: loading, error: queryError } = useQuery({
    queryKey: ["admin-dashboard-stats"],
    queryFn: async () => {
      const data = await callAdminApi("dashboard_stats");
      return data as DashboardStats;
    },
    enabled: isAdmin,
    staleTime: 60000, // Cache for 60 seconds - prevents duplicate calls
    refetchOnWindowFocus: false,
  });

  const error = queryError ? (queryError instanceof Error ? queryError.message : "Failed to load stats") : null;

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

  // Teal palette shades
  const tealShades = {
    primary: "text-primary", // #49cdbf
    light: "text-[hsl(170,55%,65%)]", // Lighter teal
    dark: "text-[hsl(170,55%,40%)]", // Darker teal
    muted: "text-[hsl(170,30%,50%)]", // Muted teal
  };

  const statCards = [
    {
      title: "Total Users",
      value: stats?.totalUsers || 0,
      description: "Registered accounts",
      icon: Users,
      color: tealShades.primary,
      bgColor: "bg-primary/10",
    },
    {
      title: "Active Subscribers",
      value: stats?.subscriberCount || 0,
      description: "Paid subscriptions",
      icon: CreditCard,
      color: tealShades.light,
      bgColor: "bg-primary/10",
    },
    {
      title: "Total Generations",
      value: stats?.totalGenerations || 0,
      description: `${stats?.activeGenerations || 0} active, ${stats?.archivedGenerations || 0} deleted`,
      icon: Activity,
      color: tealShades.dark,
      bgColor: "bg-primary/10",
    },
    {
      title: "Active Flags",
      value: stats?.activeFlags || 0,
      description: "Unresolved issues",
      icon: Flag,
      color: stats?.activeFlags ? "text-foreground" : "text-muted-foreground",
      bgColor: stats?.activeFlags ? "bg-muted" : "bg-muted",
    },
    {
      title: "Credit Purchases",
      value: stats?.creditPurchases || 0,
      description: "Total transactions",
      icon: Coins,
      color: tealShades.muted,
      bgColor: "bg-primary/10",
    },
    {
      title: "Archived Generations",
      value: stats?.archivedGenerations || 0,
      description: "Deleted by users",
      icon: Archive,
      color: "text-muted-foreground",
      bgColor: "bg-muted",
    },
  ];

  const formatCurrency = (amount: number) => {
    return `$${amount.toFixed(2)}`;
  };

  const profitMargin = stats?.profitMargin || 0;
  const profitColor = profitMargin >= 0 ? "text-primary" : "text-destructive";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Dashboard Overview</h2>
        <p className="text-muted-foreground">Real-time platform statistics and metrics</p>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-3">
        {statCards.map((stat) => (
          <Card key={stat.title} className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <div className={`p-2 rounded-lg ${stat.bgColor} shadow-sm`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value.toLocaleString()}</div>
              <CardDescription>{stat.description}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Financial Overview Section */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Financial Overview</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {/* Total Revenue */}
          <Card className="shadow-sm border-primary/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
                <TrendingUp className="h-4 w-4 text-primary" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{formatCurrency(stats?.revenue?.total || 0)}</div>
              <CardDescription>All-time earnings</CardDescription>
            </CardContent>
          </Card>

          {/* Total Spent */}
          <Card className="shadow-sm border-destructive/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
              <div className="p-2 rounded-lg bg-destructive/10 shadow-sm">
                <TrendingDown className="h-4 w-4 text-destructive" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{formatCurrency(stats?.costs?.total || 0)}</div>
              <CardDescription>API costs</CardDescription>
            </CardContent>
          </Card>

          {/* Profit Margin */}
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
              <div className={`p-2 rounded-lg ${profitMargin >= 0 ? "bg-primary/10" : "bg-destructive/10"} shadow-sm`}>
                <DollarSign className={`h-4 w-4 ${profitColor}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${profitColor}`}>
                {profitMargin >= 0 ? "+" : ""}{formatCurrency(profitMargin)}
              </div>
              <CardDescription>Revenue - Costs</CardDescription>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Revenue & Cost Breakdown */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Revenue Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Revenue Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Subscriptions</span>
                <span className="font-medium text-primary">{formatCurrency(stats?.revenue?.subscriptions || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Credit Packs</span>
                <span className="font-medium text-primary">{formatCurrency(stats?.revenue?.creditPacks || 0)}</span>
              </div>
              <div className="border-t pt-3 flex justify-between items-center font-semibold">
                <span>Total Revenue</span>
                <span className="text-primary">{formatCurrency(stats?.revenue?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Cost Breakdown by Provider */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-destructive" />
              Cost Breakdown (by Provider)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">OpenRouter (LLM)</span>
                <span className="font-medium">{formatCurrency(stats?.costs?.openrouter || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Hypereal (Images)</span>
                <span className="font-medium">{formatCurrency(stats?.costs?.hypereal || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Replicate (Images/TTS)</span>
                <span className="font-medium">{formatCurrency(stats?.costs?.replicate || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Google TTS</span>
                <span className="font-medium">{formatCurrency(stats?.costs?.googleTts || 0)}</span>
              </div>
              <div className="border-t pt-3 flex justify-between items-center font-semibold">
                <span>Total Spent</span>
                <span className="text-destructive">{formatCurrency(stats?.costs?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Quick Status Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Subscription Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Free Users</span>
                <span className="font-medium">{(stats?.totalUsers || 0) - (stats?.subscriberCount || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Paid Subscribers</span>
                <span className="font-medium text-primary">{stats?.subscriberCount || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Conversion Rate</span>
                <span className="font-medium">
                  {stats?.totalUsers 
                    ? ((stats.subscriberCount / stats.totalUsers) * 100).toFixed(1) 
                    : 0}%
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Generation Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Active Generations</span>
                <span className="font-medium text-primary">{stats?.activeGenerations || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Deleted Generations</span>
                <span className="font-medium text-muted-foreground">{stats?.archivedGenerations || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Retention Rate</span>
                <span className="font-medium">
                  {stats?.totalGenerations 
                    ? ((stats.activeGenerations / stats.totalGenerations) * 100).toFixed(1) 
                    : 0}%
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
