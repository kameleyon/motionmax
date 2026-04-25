import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useQuery } from "@tanstack/react-query";
import { Users, CreditCard, Activity, Flag, Coins, Archive, TrendingUp, TrendingDown, DollarSign, ArrowUpRight, RefreshCw } from "lucide-react";
import { AdminLoadingState } from "@/components/ui/admin-loading-state";
import { supabase } from "@/integrations/supabase/client";
import { CREDIT_PACK_PRICES } from "@/config/products";

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

  const { data: stats, isLoading: loading, error: queryError, refetch } = useQuery({
    queryKey: ["admin-dashboard-stats"],
    queryFn: async () => {
      const data = await callAdminApi("dashboard_stats");
      return data as DashboardStats;
    },
    enabled: isAdmin,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  // Credit amount → dollar price mapping (sourced from products.ts)
  const CREDIT_PACK_PRICE: Record<number, number> = Object.fromEntries(
    Object.entries(CREDIT_PACK_PRICES).map(([k, v]) => [Number(k), parseFloat(v.price.replace("$", ""))])
  );

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

      // Convert credit amounts to actual dollar prices
      const revenueThisWeek = (revenueRes.data || []).reduce((sum, t) => {
        const credits = Math.abs(t.amount || 0);
        return sum + (CREDIT_PACK_PRICE[credits] || 0);
      }, 0);

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
    return <AdminLoadingState />;
  }

  if (error) {
    return (
      <div className="text-center py-12 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  const formatCurrency = (amount: number) => `$${amount.toFixed(2)}`;

  const profitMargin = stats?.profitMargin || 0;
  const profitColor = profitMargin >= 0 ? "text-primary" : "text-destructive";

  const statCards = [
    {
      title: "Total users",
      value: stats?.totalUsers || 0,
      description: "Registered accounts",
      icon: Users,
      color: "text-[#14C8CC]",
      bgColor: "bg-[#14C8CC]/10",
      trend: trends?.usersThisWeek,
      trendLabel: "this week",
    },
    {
      title: "Active subscribers",
      value: stats?.subscriberCount || 0,
      description: "Paid subscriptions",
      icon: CreditCard,
      color: "text-[#14C8CC]",
      bgColor: "bg-[#14C8CC]/10",
    },
    {
      title: "Total generations",
      value: stats?.totalGenerations || 0,
      description: `${stats?.activeGenerations || 0} active`,
      icon: Activity,
      color: "text-[#14C8CC]",
      bgColor: "bg-[#14C8CC]/10",
      trend: trends?.generationsThisWeek,
      trendLabel: "this week",
    },
    {
      title: "Active flags",
      value: stats?.activeFlags || 0,
      description: "Unresolved issues",
      icon: Flag,
      color: stats?.activeFlags ? "text-[#E4C875]" : "text-[#5A6268]",
      bgColor: stats?.activeFlags ? "bg-[#E4C875]/10" : "bg-white/5",
    },
    {
      title: "Credit purchases",
      value: stats?.creditPurchases || 0,
      description: "Total transactions",
      icon: Coins,
      color: "text-[#E4C875]",
      bgColor: "bg-[#E4C875]/10",
    },
    {
      title: "Archived",
      value: stats?.archivedGenerations || 0,
      description: "Deleted by users",
      icon: Archive,
      color: "text-[#5A6268]",
      bgColor: "bg-white/5",
    },
  ];

  // Themed Card wrapper — keeps the Card primitive but flips the
  // visual tokens to the dashboard palette so admin reads the same
  // language as Editor / Projects / Voice Lab.
  const cardClass = "shadow-none bg-[#10151A] border-white/8";
  const labelClass = "font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium";
  const valueClass = "font-serif text-[26px] font-medium text-[#ECEAE4] leading-none mt-2";
  const descClass = "text-[12px] text-[#8A9198] mt-1.5";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-serif text-[28px] sm:text-[32px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">Dashboard overview</h2>
        <p className="text-[13px] text-[#8A9198] mt-1.5">Real-time platform statistics.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {statCards.map((stat) => (
          <Card key={stat.title} className={cardClass}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className={labelClass}>{stat.title}</CardTitle>
              <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className={valueClass}>{stat.value.toLocaleString()}</div>
              <div className="flex items-center justify-between">
                <CardDescription className={descClass}>{stat.description}</CardDescription>
                {stat.trend !== undefined && stat.trend > 0 && (
                  <span className="flex items-center gap-0.5 font-mono text-[10px] tracking-wider text-[#14C8CC] mt-1.5">
                    <ArrowUpRight className="h-3 w-3" />
                    +{stat.trend} {stat.trendLabel}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div>
        <h3 className="font-serif text-[20px] sm:text-[22px] font-medium text-[#ECEAE4] mb-4">Financial overview</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className={cardClass}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className={labelClass}>Total revenue</CardTitle>
              <div className="p-2 rounded-lg bg-[#14C8CC]/10">
                <TrendingUp className="h-4 w-4 text-[#14C8CC]" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="font-serif text-[26px] font-medium text-[#14C8CC] leading-none mt-2">{formatCurrency(stats?.revenue?.total || 0)}</div>
              <div className="flex items-center justify-between">
                <CardDescription className={descClass}>All-time earnings</CardDescription>
                {trends && trends.revenueThisWeek > 0 && (
                  <span className="flex items-center gap-0.5 font-mono text-[10px] tracking-wider text-[#14C8CC] mt-1.5">
                    <ArrowUpRight className="h-3 w-3" />
                    +${trends.revenueThisWeek.toFixed(0)} this week
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className={cardClass}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className={labelClass}>Total spent</CardTitle>
              <div className="p-2 rounded-lg bg-[#E4C875]/10">
                <TrendingDown className="h-4 w-4 text-[#E4C875]" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="font-serif text-[26px] font-medium text-[#E4C875] leading-none mt-2">{formatCurrency(stats?.costs?.total || 0)}</div>
              <CardDescription className={descClass}>API costs</CardDescription>
            </CardContent>
          </Card>

          <Card className={cardClass}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className={labelClass}>Net profit</CardTitle>
              <div className={`p-2 rounded-lg ${profitMargin >= 0 ? "bg-[#14C8CC]/10" : "bg-[#E4C875]/10"}`}>
                <DollarSign className={`h-4 w-4 ${profitMargin >= 0 ? "text-[#14C8CC]" : "text-[#E4C875]"}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className={`font-serif text-[26px] font-medium leading-none mt-2 ${profitMargin >= 0 ? "text-[#14C8CC]" : "text-[#E4C875]"}`}>
                {profitMargin >= 0 ? "+" : ""}{formatCurrency(profitMargin)}
              </div>
              <CardDescription className={descClass}>Revenue − Costs</CardDescription>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className={cardClass}>
          <CardHeader>
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4] flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-[#14C8CC]" />
              Revenue breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">Subscriptions</span>
                <span className="text-[13px] font-medium text-[#14C8CC]">{formatCurrency(stats?.revenue?.subscriptions || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">Credit packs</span>
                <span className="text-[13px] font-medium text-[#14C8CC]">{formatCurrency(stats?.revenue?.creditPacks || 0)}</span>
              </div>
              <div className="border-t border-white/8 pt-3 flex justify-between items-center">
                <span className="text-[13px] font-medium text-[#ECEAE4]">Total revenue</span>
                <span className="text-[13px] font-semibold text-[#14C8CC]">{formatCurrency(stats?.revenue?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={cardClass}>
          <CardHeader>
            <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4] flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-[#E4C875]" />
              Cost breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">OpenRouter (LLM)</span>
                <span className="text-[13px] font-medium text-[#ECEAE4]">{formatCurrency(stats?.costs?.openrouter || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">Hypereal (images/video)</span>
                <span className="text-[13px] font-medium text-[#ECEAE4]">{formatCurrency(stats?.costs?.hypereal || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">Replicate (TTS)</span>
                <span className="text-[13px] font-medium text-[#ECEAE4]">{formatCurrency(stats?.costs?.replicate || 0)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-[13px] text-[#8A9198]">Google TTS</span>
                <span className="text-[13px] font-medium text-[#ECEAE4]">{formatCurrency(stats?.costs?.googleTts || 0)}</span>
              </div>
              <div className="border-t border-white/8 pt-3 flex justify-between items-center">
                <span className="text-[13px] font-medium text-[#ECEAE4]">Total spent</span>
                <span className="text-[13px] font-semibold text-[#E4C875]">{formatCurrency(stats?.costs?.total || 0)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
