import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useRefreshThumbnails } from "@/hooks/useRefreshThumbnails";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  ArrowLeft,
  Search,
  SortAsc,
  SortDesc,
  Star,
  Trash2,
  Pencil,
  Eye,
  Download,
  Share2,
  MoreVertical,
  Loader2,
  FolderOpen,
  Video,
  Clapperboard,
  Wallpaper,
  Wand2,
  Clock,
  LayoutList,
  LayoutGrid,
} from "lucide-react";
import { ProjectsGridView } from "@/components/projects/ProjectsGridView";
import defaultThumbnail from "@/assets/dashboard/default-thumbnail.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { useSidebarState } from "@/hooks/useSidebarState";

type SortField = "title" | "created_at" | "updated_at";
type SortOrder = "asc" | "desc";

interface Project {
  id: string;
  title: string;
  description: string | null;
  format: string;
  style: string;
  status: string;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
  project_type?: string;
  thumbnailUrl?: string | null;
}

type ViewMode = "list" | "grid";

const formatTimestamp = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return format(d, "MMM d, h:mm a");
};

const ITEMS_PER_PAGE = 20;

export default function Projects() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { refreshThumbnails } = useRefreshThumbnails();
  const { isOpen: sidebarOpen, setIsOpen: setSidebarOpen } = useSidebarState();

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("updated_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [projectToRename, setProjectToRename] = useState<Project | null>(null);
  const [projectToShare, setProjectToShare] = useState<Project | null>(null);
  const [newTitle, setNewTitle] = useState("");
  
  // Track refreshed thumbnails separately to avoid blocking initial load
  const [refreshedThumbnails, setRefreshedThumbnails] = useState<Map<string, string | null>>(new Map());
  const refreshInProgressRef = useRef(false);

  // Debounce search input
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchQuery]);

  // Server-side paginated, sorted, filtered query
  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["all-projects", user?.id, debouncedSearch, sortField, sortOrder],
    queryFn: async ({ pageParam = 0 }) => {
      if (!user?.id) return { projects: [], nextCursor: null };
      
      const from = pageParam * ITEMS_PER_PAGE;
      const to = from + ITEMS_PER_PAGE - 1;

      let q = supabase
        .from("projects")
        .select("*")
        .eq("user_id", user.id)
        .order("is_favorite", { ascending: false })
        .order(sortField, { ascending: sortOrder === "asc" })
        .range(from, to);

      if (debouncedSearch.length > 0) {
        q = q.ilike("title", `%${debouncedSearch}%`);
      }

      const { data: projectsData, error } = await q;
      if (error) throw error;

      if (!projectsData?.length) return { projects: [], nextCursor: null };

      // Fetch thumbnails for this page
      const projectIds = projectsData.map(p => p.id);
      const { data: generations } = await supabase
        .from("generations")
        .select("project_id, scenes")
        .in("project_id", projectIds)
        .eq("status", "complete")
        .order("created_at", { ascending: false });

      const thumbnailMap: Record<string, string | null> = {};
      if (generations) {
        for (const gen of generations) {
          if (thumbnailMap[gen.project_id] !== undefined) continue;
          const scenes = gen.scenes as any[];
          if (Array.isArray(scenes) && scenes.length > 0) {
            const firstScene = scenes[0];
            const imageUrl = firstScene?.imageUrl || 
                            firstScene?.image_url || 
                            (Array.isArray(firstScene?.imageUrls) ? firstScene.imageUrls[0] : null);
            thumbnailMap[gen.project_id] = imageUrl || null;
          } else {
            thumbnailMap[gen.project_id] = null;
          }
        }
      }

      const projects = projectsData.map(p => ({
        ...p,
        thumbnailUrl: thumbnailMap[p.id] || null,
      })) as Project[];

      return {
        projects,
        nextCursor: projectsData.length === ITEMS_PER_PAGE ? pageParam + 1 : null,
      };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!user?.id,
    staleTime: 30000,
  });

  // Flatten all pages into a single array
  const allProjects = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap(page => page.projects);
  }, [data]);

  // Background refresh of thumbnails after initial load
  useEffect(() => {
    if (allProjects.length === 0 || refreshInProgressRef.current) return;
    
    const thumbnailInputs = allProjects
      .filter(p => p.thumbnailUrl && p.thumbnailUrl.includes("/storage/v1/object/sign/"))
      .map(p => ({ projectId: p.id, thumbnailUrl: p.thumbnailUrl! }));
    
    if (thumbnailInputs.length === 0) return;
    
    refreshInProgressRef.current = true;
    
    refreshThumbnails(thumbnailInputs)
      .then(refreshedMap => {
        setRefreshedThumbnails(refreshedMap);
      })
      .catch(err => {
        console.warn("[Projects] Background thumbnail refresh failed:", err);
      })
      .finally(() => {
        refreshInProgressRef.current = false;
      });
  }, [allProjects, refreshThumbnails]);

  // Merge refreshed thumbnails with projects
  const projectsWithThumbnails = useMemo(() => {
    if (refreshedThumbnails.size === 0) return allProjects;
    return allProjects.map(p => ({
      ...p,
      thumbnailUrl: refreshedThumbnails.get(p.id) ?? p.thumbnailUrl,
    }));
  }, [allProjects, refreshedThumbnails]);

  // Mutations
  const deleteProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      const { error } = await supabase.from("projects").delete().eq("id", projectId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
      toast.success("Project deleted");
    },
    onError: (error) => toast.error("Failed to delete: " + error.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from("projects").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
      setSelectedIds(new Set());
      toast.success("Projects deleted");
    },
    onError: (error) => toast.error("Failed to delete: " + error.message),
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const { error } = await supabase.from("projects").update({ title }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
      toast.success("Project renamed");
    },
    onError: (error) => toast.error("Failed to rename: " + error.message),
  });

  const toggleFavoriteMutation = useMutation({
    mutationFn: async ({ id, is_favorite }: { id: string; is_favorite: boolean }) => {
      const { error } = await supabase.from("projects").update({ is_favorite }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
    },
    onError: (error) => toast.error("Failed to update: " + error.message),
  });

  // Selection handlers
  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === projectsWithThumbnails.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(projectsWithThumbnails.map((p) => p.id)));
    }
  };

  // Action handlers
  const getCreateMode = (projectType?: string | null) => {
    switch (projectType) {
      case "storytelling":
        return "storytelling";
      case "smartflow":
        return "smartflow";
      case "cinematic":
        return "cinematic";
      default:
        return "doc2video";
    }
  };

  const handleView = (project: Project) => {
    const mode = getCreateMode(project.project_type);
    navigate(`/app/create?mode=${mode}&project=${project.id}`);
  };

  const handleRename = (project: Project) => {
    setProjectToRename(project);
    setNewTitle(project.title);
    setRenameDialogOpen(true);
  };

  const confirmRename = () => {
    if (projectToRename && newTitle.trim()) {
      renameMutation.mutate({ id: projectToRename.id, title: newTitle.trim() });
      setRenameDialogOpen(false);
      setProjectToRename(null);
    }
  };

  const handleDelete = (project: Project) => {
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

  const handleBulkDelete = () => {
    if (selectedIds.size > 0) {
      setBulkDeleteDialogOpen(true);
    }
  };

  const confirmBulkDelete = () => {
    bulkDeleteMutation.mutate(Array.from(selectedIds));
    setBulkDeleteDialogOpen(false);
  };

  const handleToggleFavorite = (project: Project, e?: React.MouseEvent) => {
    e?.stopPropagation();
    toggleFavoriteMutation.mutate({ id: project.id, is_favorite: !project.is_favorite });
  };

  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [downloadingProjectId, setDownloadingProjectId] = useState<string | null>(null);

  const handleShare = async (project: Project) => {
    setProjectToShare(project);
    setShareUrl("");
    setShareDialogOpen(true);
    setShareLoading(true);

    try {
      // Check if share already exists
      const { data: existingShare } = await supabase
        .from("project_shares")
        .select("share_token")
        .eq("project_id", project.id)
        .eq("user_id", user?.id)
        .maybeSingle();

      if (existingShare?.share_token) {
        setShareUrl(`${window.location.origin}/share/${existingShare.share_token}`);
      } else {
        // Create new share token
        const shareToken = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const { error } = await supabase.from("project_shares").insert({
          project_id: project.id,
          user_id: user?.id,
          share_token: shareToken,
        });

        if (error) throw error;
        setShareUrl(`${window.location.origin}/share/${shareToken}`);
      }
    } catch (err: any) {
      toast.error("Failed to create share link");
      console.error(err);
    } finally {
      setShareLoading(false);
    }
  };

  const copyShareLink = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied to clipboard");
    }
  };

  const handleDownload = async (project: Project) => {
    setDownloadingProjectId(project.id);
    
    try {
      // Fetch the latest complete generation for this project
      const { data: generation, error } = await supabase
        .from("generations")
        .select("scenes, video_url")
        .eq("project_id", project.id)
        .eq("status", "complete")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (error || !generation) {
        toast.error("No video found. Please generate a video first.");
        return;
      }

      // If there's a pre-rendered video URL, download that
      if (generation.video_url) {
        const response = await fetch(generation.video_url);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${project.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success("Video download started");
        return;
      }

      // Otherwise, redirect to workspace to export
      toast.info("Redirecting to workspace to export video...");
      const mode = getCreateMode(project.project_type);
      navigate(`/app/create?mode=${mode}&project=${project.id}`);
    } catch (err: any) {
      toast.error("Download failed: " + err.message);
    } finally {
      setDownloadingProjectId(null);
    }
  };

  const SortIcon = sortOrder === "asc" ? SortAsc : SortDesc;

  return (
    <SidebarProvider defaultOpen={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />

        <main className="flex-1 flex flex-col">
          {/* Header */}
          <header className="sticky top-0 z-40 grid h-14 sm:h-16 grid-cols-3 items-center border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
            <div className="flex items-center justify-start gap-2">
              <SidebarTrigger />
              <ThemedLogo className="hidden lg:block h-10 w-auto" />
            </div>
            <div className="flex justify-center lg:hidden">
              <ThemedLogo className="h-10 w-auto" />
            </div>
            <div className="flex items-center justify-end">
              <ThemeToggle />
            </div>
          </header>

          <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">All Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">Manage, organize, and access all your video creations</p>
          </motion.div>

        {/* Toolbar */}
        <div className="flex flex-col lg:flex-row gap-4 mt-6 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-card border-border/50"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
              <SelectTrigger className="w-[140px] bg-card border-border/50">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="created_at">Created</SelectItem>
                <SelectItem value="updated_at">Updated</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
              className="border-border/50"
            >
              <SortIcon className="h-4 w-4" />
            </Button>
            <div className="flex border border-border/50 rounded-lg overflow-hidden">
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="icon"
                onClick={() => setViewMode("list")}
                className="rounded-none border-0"
              >
                <LayoutList className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "grid" ? "secondary" : "ghost"}
                size="icon"
                onClick={() => setViewMode("grid")}
                className="rounded-none border-0"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </div>
            {selectedIds.size > 0 && (
              <Button variant="destructive" onClick={handleBulkDelete} className="gap-2">
                <Trash2 className="h-4 w-4" />
                Delete ({selectedIds.size})
              </Button>
            )}
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : projectsWithThumbnails.length === 0 ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="p-6 rounded-full bg-muted/50 mb-6">
              <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No projects found</h3>
            <p className="text-muted-foreground mb-6 max-w-md">
              {searchQuery ? "Try a different search term" : "Create your first project to get started"}
            </p>
            {!searchQuery && (
              <Button onClick={() => navigate("/app/create?mode=doc2video")} className="gap-2">
                <Wand2 className="h-4 w-4" />
                Create Project
              </Button>
            )}
          </motion.div>
        ) : viewMode === "grid" ? (
          /* Grid View */
          <>
            <ProjectsGridView
              projects={projectsWithThumbnails}
              onView={handleView}
              onRename={handleRename}
              onDelete={handleDelete}
              onShare={handleShare}
              onDownload={handleDownload}
              onToggleFavorite={handleToggleFavorite}
              downloadingProjectId={downloadingProjectId}
            />
            {/* Show More Button for Grid */}
            {hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button 
                  variant="outline" 
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="gap-2"
                >
                  {isFetchingNextPage ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Loading...</>
                  ) : (
                    "Show more"
                  )}
                </Button>
              </div>
            )}
          </>
        ) : (
          /* List View */
          <div className="rounded-xl border border-border/60 overflow-hidden bg-card/50">
            <div className="overflow-x-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent border-border/60 bg-muted/20">
                  <TableHead className="w-8 sm:w-10 py-2 px-1.5 sm:px-3">
                    <Checkbox
                      checked={selectedIds.size === projectsWithThumbnails.length && projectsWithThumbnails.length > 0}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                  <TableHead className="w-8 sm:w-10 py-2 px-1 sm:px-3" />
                  <TableHead className="py-2 px-1 sm:px-3 text-[11px] uppercase tracking-wider text-muted-foreground/70">Title</TableHead>
                  <TableHead className="hidden md:table-cell py-2 px-3 text-[11px] uppercase tracking-wider text-muted-foreground/70">Format</TableHead>
                  <TableHead className="hidden lg:table-cell py-2 px-3 text-[11px] uppercase tracking-wider text-muted-foreground/70">Style</TableHead>
                  <TableHead className="w-8 sm:w-10 py-2 px-1 sm:px-3" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence>
                  {projectsWithThumbnails.map((project, index) => (
                    <motion.tr
                      key={project.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ delay: index * 0.02 }}
                    className={cn(
                      "cursor-pointer hover:bg-muted/30 border-b border-primary/20 group",
                      selectedIds.has(project.id) && "bg-primary/5"
                    )}
                    >
                      <TableCell className="py-2 px-1.5 sm:px-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(project.id)}
                          onCheckedChange={() => toggleSelect(project.id)}
                        />
                      </TableCell>
                      <TableCell className="py-2 px-1 sm:px-3" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 sm:h-8 sm:w-8"
                          onClick={(e) => handleToggleFavorite(project, e)}
                        >
                          <Star
                            className={cn(
                              "h-3.5 w-3.5 sm:h-4 sm:w-4 transition-colors",
                              project.is_favorite
                                ? "fill-primary text-primary"
                                : "text-muted-foreground hover:text-primary"
                            )}
                          />
                        </Button>
                      </TableCell>
                      <TableCell className="py-2 px-1 sm:px-3 max-w-0" onClick={() => handleView(project)}>
                        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
                          <div className="p-1 sm:p-2 rounded-lg bg-[hsl(var(--thumbnail-surface))] border border-border/20 shrink-0">
                            {project.project_type === "storytelling" ? (
                              <Clapperboard className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                            ) : project.project_type === "smartflow" || project.project_type === "smart-flow" ? (
                              <Wallpaper className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                            ) : (
                              <Video className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <span className="font-medium group-hover:text-primary transition-colors truncate block text-xs sm:text-sm">
                              {project.title}
                            </span>
                            <span className="text-[10px] sm:text-xs text-muted-foreground truncate block">
                              {formatTimestamp(project.updated_at)}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 px-3 hidden md:table-cell" onClick={() => handleView(project)}>
                        <span className="capitalize text-muted-foreground">{project.format}</span>
                      </TableCell>
                      <TableCell className="py-2.5 px-3 hidden lg:table-cell" onClick={() => handleView(project)}>
                        <span className="capitalize text-muted-foreground">{project.style.replace(/-/g, " ")}</span>
                      </TableCell>
                      <TableCell className="py-2.5 px-2 sm:px-3" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7 sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => handleView(project)}>
                              <Eye className="mr-2 h-4 w-4" />
                              Open
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRename(project)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleShare(project)}>
                              <Share2 className="mr-2 h-4 w-4" />
                              Share
                            </DropdownMenuItem>
                            <DropdownMenuItem 
                              onClick={() => handleDownload(project)}
                              disabled={downloadingProjectId === project.id}
                            >
                              {downloadingProjectId === project.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="mr-2 h-4 w-4" />
                              )}
                              {downloadingProjectId === project.id ? "Downloading..." : "Download Video"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDelete(project)}
                              className="text-muted-foreground focus:text-foreground"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              </TableBody>
            </Table>
            </div>

            {/* Show More Button */}
            {hasNextPage && (
              <div className="p-4 border-t border-border/30 flex justify-center">
                <Button 
                  variant="outline" 
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="gap-2"
                >
                  {isFetchingNextPage ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Loading...</>
                  ) : (
                    "Show more"
                  )}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Footer Stats */}
        <div className="mt-6 flex items-center justify-between text-sm text-muted-foreground">
          <span className="text-xs sm:text-sm">
            {projectsWithThumbnails.length} project{projectsWithThumbnails.length !== 1 ? "s" : ""} loaded
            {selectedIds.size > 0 && ` • ${selectedIds.size} selected`}
          </span>
          {projectsWithThumbnails.length > 0 && (
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="flex items-center gap-1 sm:gap-1.5" title="Explainers">
                <Video className="h-3.5 w-3.5" />
                <span className="text-xs sm:text-sm">{projectsWithThumbnails.filter(p => p.project_type === "doc2video" || !p.project_type).length}</span>
                <span className="hidden sm:inline text-xs sm:text-sm">explainers</span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5" title="Stories">
                <Clapperboard className="h-3.5 w-3.5" />
                <span className="text-xs sm:text-sm">{projectsWithThumbnails.filter(p => p.project_type === "storytelling").length}</span>
                <span className="hidden sm:inline text-xs sm:text-sm">stories</span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5" title="SmartFlow">
                <Wallpaper className="h-3.5 w-3.5" />
                <span className="text-xs sm:text-sm">{projectsWithThumbnails.filter(p => p.project_type === "smartflow").length}</span>
                <span className="hidden sm:inline text-xs sm:text-sm">smartflow</span>
              </div>
            </div>
          )}
        </div>
        </div>
        </div>
        </main>
        {/* Dialogs live outside scrollable content but inside sidebar wrapper */}

      {/* Delete Dialog */}
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
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Dialog */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Projects</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedIds.size} project{selectedIds.size !== 1 ? "s" : ""}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmBulkDelete}
              className="bg-muted text-foreground hover:bg-muted/80"
            >
              Delete All
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Project</DialogTitle>
            <DialogDescription>Enter a new name for this project.</DialogDescription>
          </DialogHeader>
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Project title"
            onKeyDown={(e) => e.key === "Enter" && confirmRename()}
            className="bg-muted/50"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmRename} disabled={!newTitle.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share Project</DialogTitle>
            <DialogDescription>
              Anyone with this link can view your project (view-only, no download).
            </DialogDescription>
          </DialogHeader>
          {shareLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                readOnly
                value={shareUrl}
                className="flex-1 bg-muted/50"
              />
              <Button onClick={copyShareLink} disabled={!shareUrl}>Copy</Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Viewers cannot download, edit, or save the project.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShareDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </SidebarProvider>
  );
}
