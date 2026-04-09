import {
  CircleUserRound,
  Settings,
  LogOut,
  Moon,
  Sun,
  Video,
  Loader2,
  PanelLeftClose,
  PanelLeft,
  History,
  Trash2,
  MoreVertical,
  FolderOpen,
  Crown,
  Check,
  Wand2,
  Home,
  Clapperboard,
  Mic,
  Wallpaper,
  MicVocal,
  Shield,
  Film,
  ChevronDown,
  Plus,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useNavigate, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useSubscription, STRIPE_PLANS } from "@/hooks/useSubscription";
import { ProjectSearch } from "@/components/layout/ProjectSearch";
import { useState, useEffect } from "react";
import { toast } from "sonner";

// No external props needed — navigation is handled internally

import { PLAN_LIMITS } from "@/lib/planLimits";

const CREATOR_PERKS = [
  `${PLAN_LIMITS.creator.creditsPerMonth} credits/month + ${PLAN_LIMITS.creator.dailyFreeCredits} daily`,
  "All video types",
  "1080p HD quality",
  "All 23 visual styles",
  "All caption styles",
  "No watermark",
];

export function AppSidebar() {
  const { state, isMobile, toggleSidebar, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const { theme, setTheme } = useTheme();
  const { user, signOut } = useAuth();
  const { isAdmin } = useAdminAuth();
  const { plan, cancelAtPeriodEnd, createCheckout, isLoading: subscriptionLoading } = useSubscription();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isCreateRoute = location.pathname === "/app/create";

  /** Navigate and close the mobile sidebar */
  const navTo = (path: string) => {
    if (isMobile) setOpenMobile(false);
    navigate(path);
  };
  const [createOpen, setCreateOpen] = useState(isCreateRoute);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; title: string } | null>(null);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  // Upgrade modal is now contextual — shown only when user hits a feature limit
  // (triggered by workspace validation, not auto-shown on session start)

  const handleUpgradeNow = async () => {
    try {
      setUpgradeLoading(true);
      await createCheckout(STRIPE_PLANS.starter.monthly.priceId, "subscription");
      setUpgradeModalOpen(false);
    } catch (error) {
      toast.error("Failed to start checkout. Please try again.");
    } finally {
      setUpgradeLoading(false);
    }
  };

  const getPlanDisplayName = () => {
    if (cancelAtPeriodEnd) return "Cancelled";
    switch (plan as string) {
      case "creator": case "starter": return "Creator";
      case "studio": case "professional": return "Studio";
      case "enterprise": return "Enterprise";
      default: return "Free Plan";
    }
  };

  // Fetch user profile for display name
  const { data: profile } = useQuery({
    queryKey: ["user-profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", user.id)
        .single();
      if (error) return null;
      return data;
    },
    enabled: !!user?.id,
  });

  const displayName = profile?.display_name || user?.email?.split("@")[0] || "User";

  const { data: recentProjects = [], isLoading } = useQuery({
    queryKey: ["recent-projects", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from("projects")
        .select("id, title, created_at, project_type")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const deleteProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      // Delete associated records first to satisfy foreign key constraints
      await supabase.from("generations").delete().eq("project_id", projectId);
      await supabase.from("project_shares").delete().eq("project_id", projectId);
      await supabase.from("project_characters").delete().eq("project_id", projectId);
      const { error } = await supabase.from("projects").delete().eq("id", projectId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
      queryClient.invalidateQueries({ queryKey: ["projects-search"] });
      toast.success("Project deleted successfully");
    },
    onError: (error) => {
      toast.error("Failed to delete project. Please try again.");
    },
  });

  const handleDeleteProject = (project: { id: string; title: string }, e: React.MouseEvent) => {
    e.stopPropagation();
    setProjectToDelete(project);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (projectToDelete) {
      deleteProjectMutation.mutate(projectToDelete.id);
      setDeleteDialogOpen(false);
      setProjectToDelete(null);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const isActiveRoute = (path: string) => location.pathname === path;
  const currentMode = new URLSearchParams(location.search).get("mode") || "doc2video";

  return (
    <>
    <Sidebar collapsible="icon" className="border-r border-sidebar-border/50 text-foreground/80 dark:text-white/80 max-h-screen overflow-hidden flex flex-col">
      <SidebarHeader className="p-3 flex-shrink-0">
        {/* Mobile: Profile icon at top instead of collapse toggle */}
        {isMobile ? (
          <div className="flex justify-between items-center mb-3 pr-8">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-lg gap-2 px-2"
                >
                  <CircleUserRound className="h-5 w-5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 rounded-xl border-border/50 shadow-sm">
                <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/settings")}>
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/usage")}>
                  <History className="mr-2 h-4 w-4" />
                  <span>Usage & Billing</span>
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/admin")}>
                    <Shield className="mr-2 h-4 w-4" />
                    <span>Admin</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className="bg-border/50" />
                <DropdownMenuItem
                  className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground"
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                >
                  <Sun className="mr-2 h-4 w-4 dark:hidden" />
                  <Moon className="mr-2 hidden h-4 w-4 dark:block" />
                  <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-border/50" />
                <DropdownMenuItem
                  className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground"
                  onClick={handleSignOut}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log Out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-xs text-muted-foreground">{getPlanDisplayName()}</span>
          </div>
        ) : (
          /* Desktop: Collapse/Expand Toggle */
          <div className={`flex ${isCollapsed ? "justify-center" : "justify-end"} mb-3`}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebar}
                  aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  className="h-7 w-7 sm:h-8 sm:w-8 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-accent"
                >
                  {isCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{isCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Search bar - only when expanded (desktop) or always on mobile */}
        {(!isCollapsed || isMobile) && (
          <div>
            <ProjectSearch onSelectProject={(projectId) => {
              navTo(`/app/create?project=${projectId}`);
            }} />
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className={`px-2 flex flex-col flex-1 min-h-0 ${isMobile ? 'overflow-y-auto' : 'overflow-y-auto'}`}>
        {/* Main Navigation - flat list */}
        <SidebarGroup className="mt-2">
          <SidebarGroupContent>
            <SidebarMenu className={`space-y-0.5 ${isCollapsed ? "items-center" : ""}`}>
              {/* Dashboard */}
              <SidebarMenuItem className={isCollapsed ? "w-auto" : "w-full"}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => navTo("/app")}
                      aria-current={isActiveRoute("/app") ? "page" : undefined}
                      className={`cursor-pointer rounded-lg py-2.5 transition-colors ${
                        isActiveRoute("/app")
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-sidebar-accent/50"
                      } ${isCollapsed ? "w-10 h-10 p-0 flex items-center justify-center" : "w-full px-3"}`}
                    >
                      <Home className="h-4 w-4 shrink-0" />
                      {!isCollapsed && <span className="text-sm">Dashboard</span>}
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">Dashboard</TooltipContent>}
                </Tooltip>
              </SidebarMenuItem>

              {/* Create — collapsible group with 4 modes */}
              <SidebarMenuItem className={isCollapsed ? "w-auto" : "w-full"}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => isCollapsed ? navTo("/app/create?mode=doc2video") : setCreateOpen(!createOpen)}
                      className={`cursor-pointer rounded-lg py-2.5 transition-colors ${
                        isCreateRoute && !new URLSearchParams(location.search).has("project")
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-sidebar-accent/50"
                      } ${isCollapsed ? "w-10 h-10 p-0 flex items-center justify-center" : "w-full px-3"}`}
                    >
                      <Plus className="h-4 w-4 shrink-0" />
                      {!isCollapsed && (
                        <>
                          <span className="text-sm flex-1">Create</span>
                          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${createOpen ? "rotate-180" : ""}`} />
                        </>
                      )}
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">Create</TooltipContent>}
                </Tooltip>

                {/* Sub-menu — creation modes */}
                {!isCollapsed && createOpen && (
                  <div className="ml-5 mt-1 space-y-0.5 border-l border-border/30 pl-2">
                    {[
                      { mode: "doc2video", label: "Explainers", icon: Video },
                      { mode: "storytelling", label: "Visual Stories", icon: Clapperboard },
                      { mode: "smartflow", label: "Smart Flow", icon: Wallpaper },
                    ].map(({ mode, label, icon: Icon }) => (
                      <button
                        key={mode}
                        onClick={() => navTo(`/app/create?mode=${mode}`)}
                        className={`flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-sm transition-colors ${
                          isCreateRoute && currentMode === mode && !new URLSearchParams(location.search).has("project")
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50"
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        {label}
                      </button>
                    ))}

                    {/* Cinematic — with lock for non-pro */}
                    {(() => {
                      const canAccessCinematic = isAdmin || plan === "studio" || (plan as string) === "professional" || plan === "enterprise" || plan === "creator";
                      return (
                        <button
                          onClick={() => canAccessCinematic && navTo("/app/create?mode=cinematic")}
                          className={`flex items-center gap-2 w-full rounded-lg px-2.5 py-2 text-sm transition-colors ${
                            !canAccessCinematic
                              ? "opacity-40 cursor-not-allowed text-muted-foreground"
                              : isCreateRoute && currentMode === "cinematic" && !new URLSearchParams(location.search).has("project")
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/50"
                          }`}
                        >
                          <Film className="h-3.5 w-3.5 shrink-0" />
                          <span className="flex items-center gap-1.5">
                            Cinematic
                            <span className="text-[10px] px-1 py-0.5 rounded bg-primary/20 text-primary leading-none">Beta</span>
                            {!canAccessCinematic && <Crown className="h-3 w-3 text-[hsl(var(--gold))]" />}
                          </span>
                        </button>
                      );
                    })()}
                  </div>
                )}
              </SidebarMenuItem>

              {/* Voice Lab */}
              <SidebarMenuItem className={isCollapsed ? "w-auto" : "w-full"}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => navTo("/voice-lab")}
                      className={`cursor-pointer rounded-lg py-2.5 transition-colors ${
                        isActiveRoute("/voice-lab") 
                          ? "bg-primary/10 text-primary" 
                          : "hover:bg-sidebar-accent/50"
                      } ${isCollapsed ? "w-10 h-10 p-0 flex items-center justify-center" : "w-full px-3"}`}
                    >
                      <Mic className="h-4 w-4 shrink-0" />
                      {!isCollapsed && <span className="text-sm">Voice Lab</span>}
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">Voice Lab</TooltipContent>}
                </Tooltip>
              </SidebarMenuItem>

              {/* All Projects */}
              <SidebarMenuItem className={isCollapsed ? "w-auto" : "w-full"}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      onClick={() => navTo("/projects")}
                      className={`cursor-pointer rounded-lg py-2.5 transition-colors ${
                        isActiveRoute("/projects") 
                          ? "bg-primary/10 text-primary" 
                          : "hover:bg-sidebar-accent/50"
                      } ${isCollapsed ? "w-10 h-10 p-0 flex items-center justify-center" : "w-full px-3"}`}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0" />
                      {!isCollapsed && <span className="text-sm">All Projects</span>}
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">All Projects</TooltipContent>}
                </Tooltip>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Recent Projects Section - only show when expanded or on mobile */}
        {(!isCollapsed || isMobile) && (
          <SidebarGroup className={`mt-4 ${isMobile ? '' : 'flex-1 min-h-0 flex flex-col'}`}>
            <SidebarGroupLabel className="text-xs sm:text-xs font-medium uppercase tracking-wider text-foreground/50 dark:text-white/50 px-3 py-2 flex items-center gap-2 flex-shrink-0">
              <History className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              <span>Recent</span>
            </SidebarGroupLabel>
            <SidebarGroupContent className={`mt-1 ml-3 ${isMobile ? '' : 'flex-1 min-h-0 overflow-y-auto scrollbar-thin narrow'}`}>
              <SidebarMenu className="space-y-0.5 sm:space-y-1 border-l border-foreground/10 dark:border-white/10 pl-2">
                {isLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-foreground/50 dark:text-white/50" />
                  </div>
                ) : recentProjects.length === 0 ? (
                  <div className="px-3 py-2 text-xs sm:text-sm text-foreground/50 dark:text-white/50">No projects yet</div>
                ) : (
                  recentProjects.map((project) => {
                    const projectMode = project.project_type === "storytelling" 
                      ? "storytelling" 
                      : project.project_type === "smartflow" || project.project_type === "smart-flow"
                        ? "smartflow"
                        : project.project_type === "cinematic"
                          ? "cinematic"
                          : "doc2video";
                    const currentProjectId = new URLSearchParams(location.search).get("project");
                    const isActiveProject = currentProjectId === project.id;
                    
                    // Get appropriate icon for project type
                    const ProjectIcon = project.project_type === "storytelling" 
                      ? Clapperboard 
                      : project.project_type === "smartflow" || project.project_type === "smart-flow"
                        ? Wallpaper
                        : project.project_type === "cinematic"
                          ? Film
                          : Video;
                    
                    return (
                      <SidebarMenuItem key={project.id} className="group relative">
                      <SidebarMenuButton
                          onClick={(e) => {
                            e.preventDefault();
                            navTo(`/app/create?mode=${projectMode}&project=${project.id}`);
                          }}
                          className={`w-full cursor-pointer rounded-lg px-3 py-2 sm:py-2.5 transition-colors pr-8 ${
                            isActiveProject 
                              ? "bg-primary/10 text-primary" 
                              : "hover:bg-sidebar-accent/50"
                          }`}
                        >
                          <ProjectIcon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${isActiveProject ? "text-primary" : "text-foreground/60 dark:text-white/60"}`} />
                          <span className="truncate text-xs sm:text-sm font-normal opacity-85">{project.title}</span>
                        </SidebarMenuButton>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 sm:h-6 sm:w-6 opacity-0 group-hover:opacity-100 transition-opacity text-foreground"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              className="cursor-pointer text-sm focus:bg-accent focus:text-accent-foreground"
                              onClick={(e) => handleDeleteProject(project, e as unknown as React.MouseEvent)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    );
                  })
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      {/* Footer with profile - hide on mobile since profile is in header */}
      {!isMobile && (
        <SidebarFooter className="p-2 sm:p-3 flex-shrink-0">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className={`w-full rounded-lg hover:bg-sidebar-accent hover:text-accent ${
                      isCollapsed ? "justify-center px-0" : "justify-start gap-2 sm:gap-3 px-2 sm:px-3"
                    } py-2 sm:py-2.5`}
                    size={isCollapsed ? "icon" : "default"}
                  >
                    <CircleUserRound className="h-6 w-6 text-muted-foreground shrink-0" />
                    {!isCollapsed && (
                      <div className="flex flex-col items-start overflow-hidden">
                        <span className="truncate text-xs sm:text-sm">{displayName}</span>
                        <span className="text-xs sm:text-xs text-muted-foreground/70">{getPlanDisplayName()}</span>
                      </div>
                    )}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              {isCollapsed && <TooltipContent side="right">Account</TooltipContent>}
            </Tooltip>
            <DropdownMenuContent align="start" side="top" className="w-56 rounded-xl border-border/50 shadow-sm">
              <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/settings")}>
                <Settings className="mr-2 h-4 w-4" />
                <span>Settings</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/usage")}>
                <History className="mr-2 h-4 w-4" />
                <span>Usage & Billing</span>
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground" onClick={() => navTo("/admin")}>
                  <Shield className="mr-2 h-4 w-4" />
                  <span>Admin</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="bg-border/50" />
              <DropdownMenuItem
                className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                <Sun className="mr-2 h-4 w-4 dark:hidden" />
                <Moon className="mr-2 hidden h-4 w-4 dark:block" />
                <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border/50" />
              <DropdownMenuItem
                className="cursor-pointer rounded-lg focus:bg-accent focus:text-accent-foreground"
                onClick={handleSignOut}
              >
                <LogOut className="mr-2 h-4 w-4" />
                <span>Log Out</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      )}
    </Sidebar>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{projectToDelete?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Upgrade to Starter Modal */}
      <Dialog open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader className="text-center sm:text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-[hsl(var(--gold))]/20 to-[hsl(var(--gold))]/10">
              <Crown className="h-6 w-6 text-[hsl(var(--gold))]" />
            </div>
            <DialogTitle className="text-lg font-semibold">
              Upgrade to Starter
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Unlock more credits and features
            </DialogDescription>
          </DialogHeader>
          
          <div className="my-3 space-y-2">
            {CREATOR_PERKS.map((perk, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10">
                  <Check className="h-2.5 w-2.5 text-primary" />
                </div>
                <span className="text-sm">{perk}</span>
              </div>
            ))}
          </div>

          <div className="rounded-lg bg-muted/50 p-2.5 text-center">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-xl font-bold">$14.99</span>
              <span className="text-xs text-muted-foreground">/month</span>
            </div>
          </div>

          <DialogFooter className="mt-3 flex-col gap-2 sm:flex-col sm:space-x-0">
            <Button 
              onClick={handleUpgradeNow}
              disabled={upgradeLoading}
              className="w-full gap-2"
            >
              {upgradeLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Upgrade Now
            </Button>
            <Button 
              variant="outline" 
              onClick={() => setUpgradeModalOpen(false)}
              className="w-full text-muted-foreground hover:text-foreground"
            >
              No thanks
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
