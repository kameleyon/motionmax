import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, Shield, Users, DollarSign, LayoutDashboard, Flag, FileText,
  AlertTriangle, Cable, Film, LogOut, Activity, Server, TrendingUp,
  ChevronLeft, ChevronDown,
} from "lucide-react";
import { AdminOverview } from "@/components/admin/AdminOverview";
import { AdminSubscribers } from "@/components/admin/AdminSubscribers";
import { AdminRevenue } from "@/components/admin/AdminRevenue";
import { AdminGenerations } from "@/components/admin/AdminGenerations";
import { AdminFlags } from "@/components/admin/AdminFlags";
import { AdminLogs } from "@/components/admin/AdminLogs";
import { AdminApiCalls } from "@/components/admin/AdminApiCalls";
import { AdminQueueMonitor } from "@/components/admin/AdminQueueMonitor";
import { AdminWorkerHealth } from "@/components/admin/AdminWorkerHealth";
import { AdminPerformanceMetrics } from "@/components/admin/AdminPerformanceMetrics";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/* ── 1.1 Sidebar nav groups (replaces 10-tab horizontal bar) ──── */

const NAV_GROUPS = [
  {
    title: "Dashboard",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
    ],
  },
  {
    title: "Users",
    items: [
      { id: "subscribers", label: "Subscribers", icon: Users },
      { id: "flags", label: "Flags", icon: Flag },
    ],
  },
  {
    title: "Business",
    items: [
      { id: "revenue", label: "Revenue", icon: DollarSign },
      { id: "generations", label: "Generations", icon: Film },
    ],
  },
  {
    title: "System",
    items: [
      { id: "queue", label: "Queue", icon: Activity },
      { id: "worker", label: "Worker", icon: Server },
      { id: "performance", label: "Performance", icon: TrendingUp },
      { id: "api-calls", label: "API Calls", icon: Cable },
      { id: "logs", label: "Logs", icon: FileText },
    ],
  },
];

function AdminContent({ tab }: { tab: string }) {
  switch (tab) {
    case "overview": return <AdminOverview />;
    case "subscribers": return <AdminSubscribers />;
    case "revenue": return <AdminRevenue />;
    case "generations": return <AdminGenerations />;
    case "queue": return <AdminQueueMonitor />;
    case "worker": return <AdminWorkerHealth />;
    case "performance": return <AdminPerformanceMetrics />;
    case "api-calls": return <AdminApiCalls />;
    case "flags": return <AdminFlags />;
    case "logs": return <AdminLogs />;
    default: return <AdminOverview />;
  }
}

export default function Admin() {
  const { isAdmin, loading, user } = useAdminAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("overview");
  const [showProdConfirm, setShowProdConfirm] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  /* 1.4 — Styled production confirmation (no more window.confirm) */
  useEffect(() => {
    const hostname = window.location.hostname;
    const isProd = hostname === "motionmax.io" || hostname === "www.motionmax.io";
    if (isProd && !sessionStorage.getItem("admin_production_confirmed")) {
      setShowProdConfirm(true);
    }
  }, []);

  useEffect(() => {
    if (!loading && !isAdmin) navigate("/app", { replace: true });
  }, [isAdmin, loading, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Verifying admin access...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
          <h1 className="type-h1">Access Denied</h1>
          <p className="text-muted-foreground">You don't have permission to access this page.</p>
        </div>
      </div>
    );
  }

  const activeLabel = NAV_GROUPS.flatMap(g => g.items).find(i => i.id === activeTab)?.label || "Overview";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Helmet><meta name="robots" content="noindex, nofollow" /></Helmet>
      {/* ── 1.3 Header with Back to App ── */}
      <header className="border-b bg-card sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/app")} className="gap-1.5 text-muted-foreground">
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </Button>
            <div className="h-5 w-px bg-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Admin</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:block text-xs text-muted-foreground">{user?.email?.split("@")[0]}</span>
            <button onClick={() => supabase.auth.signOut().then(() => navigate("/auth"))} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" aria-label="Logout">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* ── 1.1 Sidebar (desktop) — grouped sections ── */}
        <aside className="hidden md:flex w-56 flex-col border-r bg-card/50 overflow-y-auto shrink-0">
          <nav className="p-3 space-y-4">
            {NAV_GROUPS.map(group => (
              <div key={group.title}>
                <p className="type-label px-2 mb-1.5">{group.title}</p>
                <div className="space-y-0.5">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-sm transition-colors",
                          isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {/* ── 1.1 Mobile nav (collapsible dropdown) ── */}
        <div className="md:hidden flex flex-col w-full">
          <button onClick={() => setMobileNavOpen(!mobileNavOpen)} className="flex items-center justify-between w-full px-4 py-3 text-sm border-b bg-card/50">
            <span className="font-medium">{activeLabel}</span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", mobileNavOpen && "rotate-180")} />
          </button>
          {mobileNavOpen && (
            <div className="px-3 pb-3 space-y-3 border-b bg-card/50">
              {NAV_GROUPS.map(group => (
                <div key={group.title}>
                  <p className="type-label px-2 pt-2 mb-1">{group.title}</p>
                  {group.items.map(item => {
                    const Icon = item.icon;
                    return (
                      <button key={item.id} onClick={() => { setActiveTab(item.id); setMobileNavOpen(false); }} className={cn("flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-sm", activeTab === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
                        <Icon className="h-3.5 w-3.5" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Mobile main content */}
          <main className="flex-1 overflow-y-auto p-4">
            <AdminContent tab={activeTab} />
          </main>
        </div>

        {/* ── Desktop main content ── */}
        <main className="hidden md:block flex-1 overflow-y-auto p-4 sm:p-6">
          <AdminContent tab={activeTab} />
        </main>
      </div>

      {/* ── 1.4 Styled production confirmation ── */}
      <AlertDialog open={showProdConfirm} onOpenChange={setShowProdConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Production Admin Panel
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are accessing the admin panel in <strong>production</strong>. Changes here affect live user data. Proceed with caution.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => navigate("/app", { replace: true })}>Go Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => { sessionStorage.setItem("admin_production_confirmed", "true"); setShowProdConfirm(false); }}>
              I Understand, Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
