import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Shield, Users, DollarSign, LayoutDashboard, Flag, FileText, AlertTriangle, Cable, Film, LogOut } from "lucide-react";
import { AdminOverview } from "@/components/admin/AdminOverview";
import { AdminSubscribers } from "@/components/admin/AdminSubscribers";
import { AdminRevenue } from "@/components/admin/AdminRevenue";
import { AdminGenerations } from "@/components/admin/AdminGenerations";
import { AdminFlags } from "@/components/admin/AdminFlags";
import { AdminLogs } from "@/components/admin/AdminLogs";
import { AdminApiCalls } from "@/components/admin/AdminApiCalls";
import { supabase } from "@/integrations/supabase/client";

export default function Admin() {
  const { isAdmin, loading, user } = useAdminAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("overview");

  useEffect(() => {
    if (!loading && !isAdmin) {
      navigate("/app", { replace: true });
    }
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
          <h1 className="text-2xl font-bold">Access Denied</h1>
          <p className="text-muted-foreground">You don't have permission to access this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card shadow-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 shadow-sm">
                <Shield className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Admin Control Panel</h1>
                <p className="text-sm text-muted-foreground hidden md:block">Manage users, subscriptions, and monitor activity</p>
              </div>
            </div>
            {/* User info - right aligned */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate("/settings")}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground font-semibold text-sm shadow-sm">
                  {user?.email?.charAt(0).toUpperCase() || "A"}
                </div>
                <span className="hidden sm:block text-sm text-foreground">
                  {user?.email?.split("@")[0] || "Admin"}
                </span>
              </button>
              <button
                onClick={() => supabase.auth.signOut().then(() => navigate("/auth"))}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Logout"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 overflow-x-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="flex w-full overflow-x-auto scrollbar-thin">
            <TabsTrigger value="overview" className="gap-2 flex-shrink-0">
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden md:inline">Overview</span>
            </TabsTrigger>
            <TabsTrigger value="subscribers" className="gap-2 flex-shrink-0">
              <Users className="h-4 w-4" />
              <span className="hidden md:inline">Subscribers</span>
            </TabsTrigger>
            <TabsTrigger value="revenue" className="gap-2 flex-shrink-0">
              <DollarSign className="h-4 w-4" />
              <span className="hidden md:inline">Revenue</span>
            </TabsTrigger>
            <TabsTrigger value="generations" className="gap-2 flex-shrink-0">
              <Film className="h-4 w-4" />
              <span className="hidden md:inline">Generations</span>
            </TabsTrigger>
            <TabsTrigger value="api-calls" className="gap-2 flex-shrink-0">
              <Cable className="h-4 w-4" />
              <span className="hidden md:inline">API Calls</span>
            </TabsTrigger>
            <TabsTrigger value="flags" className="gap-2 flex-shrink-0">
              <Flag className="h-4 w-4" />
              <span className="hidden md:inline">Flags</span>
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-2 flex-shrink-0">
              <FileText className="h-4 w-4" />
              <span className="hidden md:inline">Logs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <AdminOverview />
          </TabsContent>

          <TabsContent value="subscribers" className="space-y-6">
            <AdminSubscribers />
          </TabsContent>

          <TabsContent value="revenue" className="space-y-6">
            <AdminRevenue />
          </TabsContent>

          <TabsContent value="generations" className="space-y-6">
            <AdminGenerations />
          </TabsContent>

          <TabsContent value="api-calls" className="space-y-6">
            <AdminApiCalls />
          </TabsContent>

          <TabsContent value="flags" className="space-y-6">
            <AdminFlags />
          </TabsContent>

          <TabsContent value="logs" className="space-y-6">
            <AdminLogs />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
