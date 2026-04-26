import { Helmet } from "react-helmet-async";
import { useState, useEffect, useMemo } from "react";
import { motion } from "framer-motion";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Zap,
  Video,
  Wallpaper,
  TrendingUp,
  Calendar,
  CreditCard,
  Receipt,
  Crown,
  Gem,
  Building2,
  Sparkles,
  ExternalLink,
  Plus,
  CheckCircle2,
  X,
  RefreshCw,
  Loader2,
  Clock,
  Coins,
  ChevronDown,
  LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { getCreditsRequired } from "@/lib/planLimits";
import { supabase } from "@/integrations/supabase/client";
import { format, startOfMonth, endOfMonth, subMonths, isSameMonth } from "date-fns";
import { toast } from "sonner";
import AppShell from "@/components/dashboard/AppShell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Plan limits configuration
const planLimits: Record<string, { credits: number; label: string; color: string; icon: LucideIcon }> = {
  free: { credits: 5, label: "Free", color: "bg-muted", icon: Sparkles },
  starter: { credits: 30, label: "Starter", color: "bg-primary/20", icon: Zap },
  creator: { credits: 100, label: "Creator", color: "bg-primary/30", icon: Crown },
  professional: { credits: 300, label: "Professional", color: "bg-primary/40", icon: Gem },
  enterprise: { credits: Infinity, label: "Enterprise", color: "bg-primary/50", icon: Building2 },
};

/** Compute the credit cost for a generation based on project type + length */
function getCreditCostForGeneration(projectType: string | undefined, length: string | undefined): number {
  const type = (projectType === "smart-flow" ? "smartflow" : projectType || "doc2video") as "doc2video" | "smartflow" | "cinematic";
  return getCreditsRequired(type, length || "short");
}

export default function Usage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const {
    plan, 
    subscribed, 
    subscriptionEnd, 
    cancelAtPeriodEnd,
    creditsBalance, 
    isLoading: isLoadingSub,
    checkSubscription,
    openCustomerPortal 
  } = useSubscription();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  // Show success state if redirected from checkout
  useEffect(() => {
    if (searchParams.get("success") === "true") {
      setShowSuccessBanner(true);
      checkSubscription();
    }
  }, [searchParams, checkSubscription]);

  // Fetch credits consumed this cycle from credit_transactions
  const { data: creditsUsedThisCycle = 0, isLoading: isLoadingCreditsUsed } = useQuery({
    queryKey: ["credits-used-cycle", user?.id],
    queryFn: async () => {
      if (!user?.id) return 0;
      const monthStart = startOfMonth(new Date());
      const monthEnd = endOfMonth(new Date());

      const { data, error } = await supabase
        .from("credit_transactions")
        .select("amount")
        .eq("user_id", user.id)
        .eq("transaction_type", "usage")
        .gte("created_at", monthStart.toISOString())
        .lte("created_at", monthEnd.toISOString());

      if (error) throw error;
      // amount is negative for usage, sum the absolute values
      return (data || []).reduce((sum, t) => sum + Math.abs(t.amount), 0);
    },
    enabled: !!user?.id,
    staleTime: 2 * 60 * 1000, // 2 min — credit cycle refreshes slowly
  });

  // Month filter state
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [visibleCount, setVisibleCount] = useState(20);
  const ITEMS_PER_PAGE = 20;
  
  // Generate month options (last 12 months)
  const monthOptions = useMemo(() => {
    const options = [{ value: "all", label: "All Time" }];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const date = subMonths(now, i);
      options.push({
        value: format(date, "yyyy-MM"),
        label: format(date, "MMMM yyyy"),
      });
    }
    return options;
  }, []);

  // Fetch ALL activity with cost and timing data
  const { data: allActivity = [], isLoading: isLoadingActivity } = useQuery({
    queryKey: ["all-activity", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const { data, error } = await supabase
        .from("generations")
        .select(`
          id,
          created_at,
          started_at,
          completed_at,
          status,
          scenes,
          project:projects(title, project_type, length)
        `)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) throw error;
      
      return (data || []).map(item => {
        const scenes = item.scenes as unknown[];
        const costTracking = scenes?.[0]?._meta?.costTracking;
        const startedAt = item.started_at ? new Date(item.started_at).getTime() : null;
        const completedAt = item.completed_at ? new Date(item.completed_at).getTime() : null;
        const generationTimeMs = startedAt && completedAt ? completedAt - startedAt : null;
        
        return {
          ...item,
          costTracking,
          generationTimeMs,
        };
      });
    },
    enabled: !!user?.id,
    staleTime: 2 * 60 * 1000, // 2 min — generation history changes infrequently mid-session
  });

  // Filter activity by selected month
  const filteredActivity = useMemo(() => {
    if (selectedMonth === "all") return allActivity;
    
    const [year, month] = selectedMonth.split("-").map(Number);
    const filterDate = new Date(year, month - 1);
    
    return allActivity.filter(activity => 
      isSameMonth(new Date(activity.created_at), filterDate)
    );
  }, [allActivity, selectedMonth]);

  // Paginated activity
  const paginatedActivity = useMemo(() => {
    return filteredActivity.slice(0, visibleCount);
  }, [filteredActivity, visibleCount]);

  // Reset visible count when filter changes
  useEffect(() => {
    setVisibleCount(ITEMS_PER_PAGE);
  }, [selectedMonth]);

  const planInfo = planLimits[plan as keyof typeof planLimits] || planLimits.free;
  const PlanIcon = planInfo.icon;
  const creditsLimit = planInfo.credits;
  const creditsPercentage = creditsLimit === Infinity ? 0 : (creditsUsedThisCycle / creditsLimit) * 100;

  // Calculate renewal date
  const renewalDate = subscriptionEnd 
    ? format(new Date(subscriptionEnd), "MMMM d, yyyy")
    : format(endOfMonth(new Date()), "MMMM d, yyyy");

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await checkSubscription();
    setIsRefreshing(false);
  };

  const handleOpenPortal = async () => {
    try {
      setIsOpeningPortal(true);
      await openCustomerPortal();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to open billing portal");
    } finally {
      setIsOpeningPortal(false);
    }
  };

  return (
    <AppShell breadcrumb="Usage & Billing">
      <Helmet>
        <title>Usage &amp; Billing · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[960px] mx-auto">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h1 className="font-serif text-[28px] sm:text-[34px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">Usage &amp; Billing</h1>
              <p className="text-[13px] sm:text-[14px] text-[#8A9198] mt-1.5">Track credits, generations, and your active subscription.</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="rounded-full h-9 w-9 shrink-0 text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          {/* Post-payment success banner */}
          {showSuccessBanner && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-4 shadow-sm">
              <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Payment successful — you're all set!</p>
                <p className="text-xs text-muted-foreground mt-0.5">Your plan is now active. Ready to start creating?</p>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" className="h-8 rounded-full text-xs" onClick={() => navigate("/app/create")}>
                    Start creating
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 rounded-full text-xs" onClick={() => navigate("/projects")}>
                    View projects
                  </Button>
                </div>
              </div>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setShowSuccessBanner(false)}
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Current Plan */}
          <Card className="mt-6 sm:mt-8 bg-[#10151A] border-white/8 shadow-none">
            <CardContent className="flex flex-col items-start justify-between gap-4 p-4 sm:p-6 sm:flex-row sm:items-center">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#14C8CC]/10">
                  <PlanIcon className="h-6 w-6 text-[#14C8CC]" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-serif text-[20px] sm:text-[24px] font-medium text-[#ECEAE4] leading-none">
                      {isLoadingSub ? <span className="inline-block h-4 w-16 rounded bg-white/10 animate-pulse" /> : planInfo.label}
                    </p>
                    <Badge className="text-[9.5px] tracking-[0.12em] uppercase font-mono bg-[#14C8CC]/10 text-[#14C8CC] border-[#14C8CC]/30">Current</Badge>
                    {cancelAtPeriodEnd && (
                      <Badge className="text-[9.5px] tracking-[0.12em] uppercase font-mono bg-[#E4C875]/10 text-[#E4C875] border-[#E4C875]/30">Cancels soon</Badge>
                    )}
                  </div>
                  <p className="text-[12.5px] text-[#8A9198] mt-1">
                    {subscribed ? `Renews on ${renewalDate}` : `Resets on ${renewalDate}`}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 w-full sm:w-auto">
                {subscribed ? (
                  <Button 
                    variant="outline"
                    className="gap-2 rounded-full flex-1 sm:flex-initial"
                    onClick={handleOpenPortal}
                    disabled={isOpeningPortal}
                  >
                    {isOpeningPortal ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CreditCard className="h-4 w-4" />
                    )}
                    Manage Subscription
                  </Button>
                ) : (
                  <Button 
                    className="gap-2 rounded-full bg-primary w-full sm:w-auto"
                    onClick={() => navigate("/pricing")}
                  >
                    <Zap className="h-4 w-4" />
                    Upgrade Plan
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Usage Stats */}
          <div className="mt-4 sm:mt-6 grid gap-4 sm:gap-6 grid-cols-1 sm:grid-cols-2">
            <Card className="bg-[#10151A] border-white/8 shadow-none">
              <CardHeader className="pb-2 px-4 sm:px-6 pt-4 sm:pt-6">
                <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium flex items-center gap-2">
                  <Coins className="h-3.5 w-3.5 text-[#14C8CC]" />
                  Credits used this cycle
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
                <div className="flex items-end justify-between">
                  <span className="font-serif text-[28px] sm:text-[32px] font-medium text-[#ECEAE4] leading-none">
                    {isLoadingCreditsUsed ? "…" : creditsUsedThisCycle}
                  </span>
                  <span className="text-[12px] text-[#8A9198]">
                    / {creditsLimit === Infinity ? "∞" : creditsLimit}
                  </span>
                </div>
                <Progress value={Math.min(creditsPercentage, 100)} className="mt-3 h-1.5 [&>div]:bg-[#14C8CC]" />
                <p className="mt-2.5 text-[11.5px] text-[#5A6268]">
                  {creditsLimit === Infinity
                    ? "Unlimited credits with your plan"
                    : `${Math.max(0, creditsLimit - creditsUsedThisCycle)} plan credits remaining this cycle`}
                </p>
              </CardContent>
            </Card>

            <Card className="bg-[#10151A] border-white/8 shadow-none">
              <CardHeader className="pb-2 px-4 sm:px-6 pt-4 sm:pt-6">
                <CardTitle className="font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268] font-medium flex items-center gap-2">
                  <Coins className="h-3.5 w-3.5 text-[#14C8CC]" />
                  Credits available
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
                <div className="flex items-end justify-between">
                  <span className="font-serif text-[28px] sm:text-[32px] font-medium text-[#ECEAE4] leading-none">
                    {isLoadingSub ? <span className="inline-block h-6 w-12 rounded bg-white/10 animate-pulse" /> : creditsBalance}
                  </span>
                  <span className="text-[12px] text-[#8A9198]">credits</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full gap-2 text-[11.5px] bg-transparent border-white/10 text-[#ECEAE4] hover:bg-white/5 hover:text-[#ECEAE4] hover:border-white/20"
                  onClick={() => navigate("/pricing")}
                >
                  <Plus className="h-3 w-3" />
                  Buy credits
                </Button>
                <p className="mt-2.5 text-[11.5px] text-[#5A6268]">
                  Credits never expire and stack with your plan.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Billing Section */}
          <Card className="mt-4 sm:mt-6 bg-[#10151A] border-white/8 shadow-none">
            <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
              <CardTitle className="font-serif text-[18px] font-medium text-[#ECEAE4] flex items-center gap-2">
                <CreditCard className="h-4 w-4 sm:h-5 sm:w-5 text-[#14C8CC]" />
                Billing &amp; payment
              </CardTitle>
              <CardDescription className="text-[12.5px] text-[#8A9198]">Manage your payment methods and billing.</CardDescription>
            </CardHeader>
            <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
              {subscribed ? (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20">
                      <PlanIcon className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">Active Subscription</p>
                      <p className="text-sm text-muted-foreground">
                        {planInfo.label} plan • {cancelAtPeriodEnd ? "Cancels" : "Renews"} {renewalDate}
                      </p>
                    </div>
                  </div>
                  <Button 
                    variant="outline" 
                    className="mt-4 gap-2 rounded-full text-sm w-full sm:w-auto"
                    onClick={handleOpenPortal}
                    disabled={isOpeningPortal}
                  >
                    {isOpeningPortal ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ExternalLink className="h-4 w-4" />
                    )}
                    Manage in Stripe
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border/50 bg-muted/20 p-4 sm:p-6 text-center">
                  <CreditCard className="h-8 w-8 sm:h-10 sm:w-10 mx-auto text-muted-foreground/50 mb-3" />
                  <p className="text-sm font-medium text-foreground">No active subscription</p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                    Upgrade your plan to unlock more features
                  </p>
                  <Button 
                    className="mt-4 gap-2 rounded-full text-sm"
                    onClick={() => navigate("/pricing")}
                  >
                    <Zap className="h-4 w-4" />
                    View Plans
                  </Button>
                </div>
              )}

              {/* Quick actions */}
              <div className="mt-4 sm:mt-6 grid gap-3 grid-cols-1 sm:grid-cols-2">
                <Button 
                  variant="ghost" 
                  className="justify-start gap-2 h-auto py-3 text-sm bg-primary/25 hover:bg-primary/35"
                  onClick={() => navigate("/pricing")}
                >
                  <Zap className="h-4 w-4 text-primary" />
                  <div className="text-left">
                    <p className="font-medium">Change Plan</p>
                    <p className="text-xs text-muted-foreground">Upgrade or downgrade</p>
                  </div>
                  <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                </Button>
                <Button 
                  variant="ghost" 
                  className="justify-start gap-2 h-auto py-3 text-sm bg-primary/25 hover:bg-primary/35"
                  onClick={handleOpenPortal}
                  disabled={!subscribed || isOpeningPortal}
                >
                  <Receipt className="h-4 w-4 text-muted-foreground" />
                  <div className="text-left">
                    <p className="font-medium">View Invoices</p>
                    <p className="text-xs text-muted-foreground">Download past invoices</p>
                  </div>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Generation Stats */}
          <div className="mt-4 sm:mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardContent className="p-4 sm:p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-primary/10">
                    <Video className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{allActivity.filter(a => a.status === "complete" || a.status === "completed").length}</p>
                    <p className="text-sm text-muted-foreground">Videos Generated</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardContent className="p-4 sm:p-6">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-primary/10">
                    <Coins className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">
                      {allActivity
                        .filter(a => a.status === "complete" || a.status === "completed")
                        .reduce((sum, a) => {
                          const proj = a.project as Record<string, unknown>;
                          return sum + getCreditCostForGeneration(proj?.project_type, proj?.length);
                        }, 0)}
                    </p>
                    <p className="text-sm text-muted-foreground">Total Credits Used</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Activity History */}
          <Card className="mt-4 sm:mt-6 border-border/50 bg-card/50 shadow-sm">
            <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                    <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                    Activity History
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">All your video generations</CardDescription>
                </div>
                <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                  <SelectTrigger className="w-full sm:w-[180px] h-9">
                    <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
                    <SelectValue placeholder="Filter by month" />
                  </SelectTrigger>
                  <SelectContent>
                    {monthOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6">
              {isLoadingActivity ? (
                <div className="py-4 space-y-3">
                  {[1,2,3,4].map(i => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3">
                      <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 w-3/4 rounded bg-muted animate-pulse" />
                        <div className="h-2 w-1/2 rounded bg-muted animate-pulse" />
                      </div>
                      <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : filteredActivity.length === 0 ? (
                <div className="py-8 text-center">
                  <Video className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No activity found</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedMonth === "all" ? "Your video generations will appear here" : "No generations in this period"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-border/60 overflow-hidden bg-card/50">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent border-border/60 bg-muted/20">
                          <TableHead className="w-8 sm:w-10 py-2 px-1.5 sm:px-3" />
                          <TableHead className="py-2 px-1 sm:px-3 text-xs uppercase tracking-wider text-muted-foreground/70">Project</TableHead>
                          <TableHead className="py-2 px-1 sm:px-3 text-xs uppercase tracking-wider text-muted-foreground/70 text-right w-16 sm:w-20">Time</TableHead>
                          <TableHead className="py-2 px-1 sm:px-3 text-xs uppercase tracking-wider text-muted-foreground/70 text-right w-12 sm:w-16">Credits</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginatedActivity.map((activity) => {
                          const formatTime = (ms: number | null) => {
                            if (!ms) return null;
                            const seconds = Math.floor(ms / 1000);
                            const minutes = Math.floor(seconds / 60);
                            const secs = seconds % 60;
                            return minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
                          };
                          
                          const isComplete = activity.status === "complete" || activity.status === "completed";
                          const isFailed = activity.status === "failed" || activity.status === "error";
                          const isGenerating = !isComplete && !isFailed;
                          const proj = activity.project as Record<string, unknown>;
                          const projectType = proj?.project_type;
                          const projectLength = proj?.length;
                          const IconComponent = projectType === "smartflow" || projectType === "smart-flow"
                              ? Wallpaper
                              : Video;
                          
                          const creditCost = getCreditCostForGeneration(projectType, projectLength);
                          
                          // Clean up title - remove redundant prefixes
                          const rawTitle = proj?.title || "Untitled Video";
                          const cleanTitle = rawTitle.replace(/^(AudioMax|MotionMax):\s*/i, "");
                          
                          return (
                            <TableRow
                              key={activity.id}
                              className="cursor-default hover:bg-muted/30 border-b border-primary/20 group"
                            >
                              <TableCell className="py-2 px-1.5 sm:px-3">
                                <div className="p-1 sm:p-2 rounded-lg bg-[hsl(var(--thumbnail-surface))] border border-border/20">
                                  <IconComponent className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                                </div>
                              </TableCell>
                              <TableCell className="py-2 px-1 sm:px-3 max-w-0">
                                <div className="min-w-0 flex-1 overflow-hidden">
                                  <div className="flex items-center gap-2">
                                    <span className="font-normal opacity-85 truncate text-xs sm:text-sm">
                                      {cleanTitle}
                                    </span>
                                    {!isComplete && (
                                      <Badge
                                        variant="secondary"
                                        className={`shrink-0 text-xs px-1.5 py-0 h-4 font-normal ${
                                          isFailed
                                            ? "bg-destructive/20 text-destructive"
                                            : "bg-primary/10 text-primary"
                                        }`}
                                      >
                                        {activity.status}
                                      </Badge>
                                    )}
                                  </div>
                                  <span className="text-xs sm:text-xs text-muted-foreground truncate block">
                                    {format(new Date(activity.created_at), "MMM d, h:mm a")}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="py-2 px-1 sm:px-3 text-right">
                                {isComplete && activity.generationTimeMs ? (
                                  <div className="flex items-center justify-end gap-0.5 sm:gap-1 text-xs sm:text-xs text-muted-foreground" title="Generation time">
                                    <Clock className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                    <span>{formatTime(activity.generationTimeMs)}</span>
                                  </div>
                                ) : isGenerating ? (
                                  <span className="text-xs sm:text-xs text-muted-foreground">—</span>
                                ) : null}
                              </TableCell>
                              <TableCell className="py-2 px-1 sm:px-3 text-right">
                                {isComplete ? (
                                  <div className="flex items-center justify-end gap-0.5 sm:gap-1 text-xs sm:text-xs text-muted-foreground" title="Credits used">
                                    <Coins className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                    <span>{creditCost}</span>
                                  </div>
                                ) : (
                                  <span className="text-xs sm:text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {/* Show more button */}
                  {visibleCount < filteredActivity.length && (
                    <div className="flex justify-center pt-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setVisibleCount(prev => prev + ITEMS_PER_PAGE)}
                        className="gap-2 hover:bg-muted"
                      >
                        <ChevronDown className="h-4 w-4" />
                        Show more ({filteredActivity.length - visibleCount} remaining)
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </AppShell>
  );
}
