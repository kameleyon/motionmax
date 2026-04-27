import { Helmet } from "react-helmet-async";
import { lazy, Suspense, useEffect, useState } from "react";
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
// Heavy admin tabs — lazy-loaded so the initial admin route is light.
// Each tab only fetches when the user navigates into it.
const AdminOverview = lazy(() => import("@/components/admin/AdminOverview").then(m => ({ default: m.AdminOverview })));
const AdminSubscribers = lazy(() => import("@/components/admin/AdminSubscribers").then(m => ({ default: m.AdminSubscribers })));
const AdminRevenue = lazy(() => import("@/components/admin/AdminRevenue").then(m => ({ default: m.AdminRevenue })));
const AdminGenerations = lazy(() => import("@/components/admin/AdminGenerations").then(m => ({ default: m.AdminGenerations })));
const AdminFlags = lazy(() => import("@/components/admin/AdminFlags").then(m => ({ default: m.AdminFlags })));
const AdminLogs = lazy(() => import("@/components/admin/AdminLogs").then(m => ({ default: m.AdminLogs })));
const AdminApiCalls = lazy(() => import("@/components/admin/AdminApiCalls").then(m => ({ default: m.AdminApiCalls })));
const AdminQueueMonitor = lazy(() => import("@/components/admin/AdminQueueMonitor").then(m => ({ default: m.AdminQueueMonitor })));
const AdminWorkerHealth = lazy(() => import("@/components/admin/AdminWorkerHealth").then(m => ({ default: m.AdminWorkerHealth })));
const AdminPerformanceMetrics = lazy(() => import("@/components/admin/AdminPerformanceMetrics").then(m => ({ default: m.AdminPerformanceMetrics })));
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import { AdminRecentActions } from "@/components/admin/AdminRecentActions";

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
  const fallback = (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading admin tab" />
    </div>
  );
  let inner: React.ReactNode;
  switch (tab) {
    case "overview": inner = <AdminOverview />; break;
    case "subscribers": inner = <AdminSubscribers />; break;
    case "revenue": inner = <AdminRevenue />; break;
    case "generations": inner = <AdminGenerations />; break;
    case "queue": inner = <AdminQueueMonitor />; break;
    case "worker": inner = <AdminWorkerHealth />; break;
    case "performance": inner = <AdminPerformanceMetrics />; break;
    case "api-calls": inner = <AdminApiCalls />; break;
    case "flags": inner = <AdminFlags />; break;
    case "logs": inner = <AdminLogs />; break;
    default: inner = <AdminOverview />;
  }
  return <Suspense fallback={fallback}>{inner}</Suspense>;
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
    if (!loading && !isAdmin) navigate("/dashboard-new", { replace: true });
  }, [isAdmin, loading, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-[#14C8CC]" />
          <p className="text-[#8A9198] text-sm">Verifying admin access…</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0D0F] text-[#ECEAE4]">
        <div className="flex flex-col items-center gap-4 text-center">
          <AlertTriangle className="h-12 w-12 text-[#E4C875]" />
          <h1 className="font-serif text-3xl text-[#ECEAE4]">Access denied</h1>
          <p className="text-[#8A9198] text-sm">You don't have permission to access this page.</p>
        </div>
      </div>
    );
  }

  const activeLabel = NAV_GROUPS.flatMap(g => g.items).find(i => i.id === activeTab)?.label || "Overview";

  return (
    <div className="min-h-screen bg-[#0A0D0F] text-[#ECEAE4] flex flex-col">
      <Helmet>
        <title>Admin · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      {/* Header — dark palette + Dashboard button now jumps to the
          new dashboard (was /app legacy). */}
      <header className="border-b border-white/8 bg-[#10151A]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/dashboard-new")}
              className="gap-1.5 text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Dashboard</span>
            </Button>
            <div className="h-5 w-px bg-white/10 hidden sm:block" />
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-[#14C8CC]" />
              <span className="text-sm font-medium text-[#ECEAE4]">Admin</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AdminRecentActions />
            <span className="hidden sm:block font-mono text-[10px] tracking-[0.12em] uppercase text-[#5A6268]">{user?.email?.split("@")[0]}</span>
            <button
              onClick={() => supabase.auth.signOut().then(() => navigate("/auth"))}
              className="p-1.5 rounded-lg text-[#8A9198] hover:text-[#E4C875] hover:bg-white/5 transition-colors"
              aria-label="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (desktop) */}
        <aside className="hidden md:flex w-56 flex-col border-r border-white/8 bg-[#10151A]/60 overflow-y-auto shrink-0">
          <nav className="p-3 space-y-4">
            {NAV_GROUPS.map(group => (
              <div key={group.title}>
                <p className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] px-2 mb-1.5">{group.title}</p>
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
                          "relative flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                          isActive
                            ? "bg-[#14C8CC]/10 text-[#14C8CC]"
                            : "text-[#8A9198] hover:text-[#ECEAE4] hover:bg-white/5",
                        )}
                      >
                        {/* Active-section indicator dot — small aqua pip on
                            the left of the active item, mirrors the dashboard
                            sidebar's active-link visual. */}
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-[#14C8CC]"
                          />
                        )}
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

        {/* Mobile nav */}
        <div className="md:hidden flex flex-col w-full">
          <button
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            className="flex items-center justify-between w-full px-4 py-3 text-[13px] border-b border-white/8 bg-[#10151A]/60 text-[#ECEAE4]"
          >
            <span className="font-medium">{activeLabel}</span>
            <ChevronDown className={cn("h-4 w-4 text-[#8A9198] transition-transform", mobileNavOpen && "rotate-180")} />
          </button>
          {mobileNavOpen && (
            <div className="px-3 pb-3 space-y-3 border-b border-white/8 bg-[#10151A]/60">
              {NAV_GROUPS.map(group => (
                <div key={group.title}>
                  <p className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#5A6268] px-2 pt-2 mb-1">{group.title}</p>
                  {group.items.map(item => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => { setActiveTab(item.id); setMobileNavOpen(false); }}
                        className={cn(
                          "flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-[13px]",
                          activeTab === item.id
                            ? "bg-[#14C8CC]/10 text-[#14C8CC]"
                            : "text-[#8A9198]",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <main className="flex-1 overflow-y-auto p-4">
            <AdminContent tab={activeTab} />
          </main>
        </div>

        <main className="hidden md:block flex-1 overflow-y-auto p-4 sm:p-6">
          <AdminContent tab={activeTab} />
        </main>
      </div>

      {/* Cmd+K command palette — global keybind, navigates between
          admin tabs based on which entity the admin selected. */}
      <AdminCommandPalette onNavigate={setActiveTab} />

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
            <AlertDialogCancel onClick={() => navigate("/dashboard-new", { replace: true })}>Go Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => { sessionStorage.setItem("admin_production_confirmed", "true"); setShowProdConfirm(false); }}>
              I Understand, Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
