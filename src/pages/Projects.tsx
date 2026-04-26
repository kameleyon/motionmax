import { Helmet } from "react-helmet-async";
import { downloadVideo, rewriteStorageUrl } from "@/hooks/export/downloadHelpers";
import { createScopedLogger } from "@/lib/logger";
import { trackEvent } from "@/hooks/useAnalytics";
import { toSafeMessage } from "@/lib/appErrors";
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useRefreshThumbnails } from "@/hooks/useRefreshThumbnails";
import { format } from "date-fns";
import { toast } from "sonner";
import {
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
  Wallpaper,
  Wand2,
  LayoutList,
  LayoutGrid,
} from "lucide-react";
import { ProjectsGridView } from "@/components/projects/ProjectsGridView";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";
import { isFlagOn } from "@/lib/featureFlags";

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
const log = createScopedLogger("Projects");

export default function Projects() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { refreshThumbnails } = useRefreshThumbnails();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("updated_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [projectTypeFilter, setProjectTypeFilter] = useState<string>("all");
  // Format/status filter chips. Status chips support multi-select
  // (OR semantics); format is mutually exclusive (16:9 vs 9:16).
  // Removed RENDERING (rarely useful as a snapshot) and HAS CAPTIONS
  // (captions metadata isn't reliably present on every project yet).
  const [formatFilter, setFormatFilter] = useState<'all' | 'landscape' | 'portrait'>('all');
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());
  
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

  // Pending-delete: IDs hidden from UI immediately; actual DB delete fires after 5 s
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
    queryKey: ["all-projects", user?.id, debouncedSearch, sortField, sortOrder, projectTypeFilter, formatFilter, Array.from(statusFilters).sort().join(',')],
    queryFn: async ({ pageParam = 0 }) => {
      if (!user?.id) return { projects: [], nextCursor: null };

      const from = pageParam * ITEMS_PER_PAGE;
      const to = from + ITEMS_PER_PAGE - 1;

      // Step 1: Fetch projects (no generation join — cleaner, faster)
      let q = supabase
        .from("projects")
        .select("*, thumbnail_url")
        .eq("user_id", user.id)
        .order("is_favorite", { ascending: false })
        .order(sortField, { ascending: sortOrder === "asc" })
        .range(from, to);

      if (debouncedSearch.length > 0) {
        q = q.ilike("title", `%${debouncedSearch}%`);
      }

      if (projectTypeFilter !== "all") {
        q = q.eq("project_type", projectTypeFilter);
      }

      if (formatFilter !== 'all') {
        q = q.eq("format", formatFilter);
      }

      if (statusFilters.size > 0) {
        q = q.in("status", Array.from(statusFilters));
      }

      const { data: projectsData, error } = await q;
      if (error) throw error;

      if (!projectsData?.length) return { projects: [], nextCursor: null };

      // Step 2: For projects missing thumbnail_url, derive one from
      // any generation that already has at least one scene with an
      // imageUrl. We used to require status='complete' which left
      // generating/processing rows with a blank navy card for the
      // entire 3-5 minute pipeline run — we have a usable preview
      // image as soon as scene 0's image lands, so use it.
      const missingIds = projectsData.filter(p => !p.thumbnail_url).map(p => p.id);
      const thumbnailMap: Record<string, string | null> = {};

      if (missingIds.length > 0) {
        const { data: generations } = await supabase
          .from("generations")
          .select("project_id, scenes")
          .in("project_id", missingIds)
          .order("created_at", { ascending: false });

        if (generations) {
          for (const gen of generations) {
            if (thumbnailMap[gen.project_id] !== undefined) continue;
            const scenes = gen.scenes as Array<{
              imageUrl?: string;
              image_url?: string;
              imageUrls?: string[];
            }> | null;
            if (!Array.isArray(scenes) || scenes.length === 0) continue;

            for (const scene of scenes) {
              const url =
                scene?.imageUrl ||
                scene?.image_url ||
                (Array.isArray(scene?.imageUrls) && scene.imageUrls.length > 0 ? scene.imageUrls[0] : null);
              if (url) {
                thumbnailMap[gen.project_id] = url;
                break;
              }
            }
            if (thumbnailMap[gen.project_id] === undefined) {
              thumbnailMap[gen.project_id] = null;
            }
          }
        }
      }

      // Step 3: Merge thumbnails
      const projects = projectsData.map(p => ({
        ...p,
        thumbnailUrl: p.thumbnail_url ?? thumbnailMap[p.id] ?? null,
      })) as unknown as Project[];

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

  // Background refresh of thumbnails after initial load (with AbortController for cleanup)
  useEffect(() => {
    if (allProjects.length === 0 || refreshInProgressRef.current) return;
    
    const thumbnailInputs = allProjects
      .filter(p => p.thumbnailUrl && p.thumbnailUrl.includes("/storage/v1/object/sign/"))
      .map(p => ({ projectId: p.id, thumbnailUrl: p.thumbnailUrl! }));
    
    if (thumbnailInputs.length === 0) return;
    
    let cancelled = false;
    refreshInProgressRef.current = true;
    
    refreshThumbnails(thumbnailInputs)
      .then(refreshedMap => {
        if (!cancelled) setRefreshedThumbnails(refreshedMap);
      })
      .catch(err => {
        if (!cancelled) log.warn("Background thumbnail refresh failed:", err);
      })
      .finally(() => {
        refreshInProgressRef.current = false;
      });

    return () => { cancelled = true; };
  }, [allProjects, refreshThumbnails]);

  // Merge refreshed thumbnails with projects
  const projectsWithThumbnails = useMemo(() => {
    const base = refreshedThumbnails.size === 0 ? allProjects : allProjects.map(p => ({
      ...p,
      thumbnailUrl: refreshedThumbnails.get(p.id) ?? p.thumbnailUrl,
    }));
    // Hide projects that are pending delete (awaiting the undo timeout)
    return pendingDeleteIds.size === 0 ? base : base.filter(p => !pendingDeleteIds.has(p.id));
  }, [allProjects, refreshedThumbnails, pendingDeleteIds]);

  // Stats strip — projects count, minutes generated, credits used in
  // the last 30 days. Standalone query so it doesn't refetch when the
  // user types in the search field. ~3 round-trips on mount; cached
  // for 60s after that. We intentionally compute minutes from
  // generations.scenes audio durations instead of a stored column —
  // we don't currently persist a video_duration field.
  const { data: stats } = useQuery({
    queryKey: ['projects-stats', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const userId = user!.id;

      // 1) project count
      const { count: projectCount } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      // 2) minutes generated — sum audioDurationMs across every scene
      // in the user's completed generations. Bounded to 100 most-recent
      // completed generations so we don't pull the entire history.
      const { data: gens } = await supabase
        .from('generations')
        .select('scenes')
        .eq('user_id', userId)
        .eq('status', 'complete')
        .order('created_at', { ascending: false })
        .limit(100);

      let totalMs = 0;
      for (const g of gens ?? []) {
        const scenes = (g.scenes as Array<Record<string, unknown>> | null) ?? [];
        for (const s of scenes) {
          const meta = (s._meta as Record<string, unknown> | undefined) ?? {};
          const ms = typeof meta.audioDurationMs === 'number'
            ? meta.audioDurationMs
            : typeof meta.estDurationMs === 'number' ? meta.estDurationMs : 10_000;
          totalMs += ms;
        }
      }

      // 3) credits used last 30d (transaction_type='usage', amount<0)
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: txns } = await supabase
        .from('credit_transactions')
        .select('amount')
        .eq('user_id', userId)
        .eq('transaction_type', 'usage')
        .gte('created_at', since);
      const creditsUsed = (txns ?? []).reduce((acc, t) => acc + Math.abs(t.amount as number), 0);

      return {
        projectCount: projectCount ?? 0,
        minutes: totalMs / 60_000,
        creditsUsed,
      };
    },
  });

  // Mutations – delete child records first to satisfy foreign key constraints
  const deleteProjectMutation = useMutation({
    mutationFn: async (projectId: string) => {
      await supabase.from("generations").delete().eq("project_id", projectId);
      await supabase.from("project_shares").delete().eq("project_id", projectId);
      await supabase.from("project_characters").delete().eq("project_id", projectId);
      const { error } = await supabase.from("projects").delete().eq("id", projectId);
      if (error) throw error;
    },
    onSuccess: (_, projectId) => {
      setPendingDeleteIds(prev => { const s = new Set(prev); s.delete(projectId); return s; });
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
    },
    onError: (error, projectId) => {
      setPendingDeleteIds(prev => { const s = new Set(prev); s.delete(projectId); return s; });
      toast.error("Failed to delete", { description: toSafeMessage(error) });
    },
  });

  // Schedule a delete with 5-second undo window
  const scheduleDelete = useCallback((projectId: string, title: string) => {
    setPendingDeleteIds(prev => new Set(prev).add(projectId));
    const toastId = `undo-delete-${projectId}`;
    const timer = setTimeout(() => {
      pendingDeleteTimers.current.delete(projectId);
      deleteProjectMutation.mutate(projectId);
    }, 5000);
    pendingDeleteTimers.current.set(projectId, timer);
    toast("Project deleted", {
      id: toastId,
      description: title,
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          clearTimeout(pendingDeleteTimers.current.get(projectId));
          pendingDeleteTimers.current.delete(projectId);
          setPendingDeleteIds(prev => { const s = new Set(prev); s.delete(projectId); return s; });
          toast.dismiss(toastId);
        },
      },
    });
  }, [deleteProjectMutation]);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await supabase.from("generations").delete().in("project_id", ids);
      await supabase.from("project_shares").delete().in("project_id", ids);
      await supabase.from("project_characters").delete().in("project_id", ids);
      const { error } = await supabase.from("projects").delete().in("id", ids);
      if (error) throw error;
    },
    onSuccess: (_, ids) => {
      setPendingDeleteIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
      setSelectedIds(new Set());
    },
    onError: (error, ids) => {
      setPendingDeleteIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      toast.error("Failed to delete", { description: toSafeMessage(error) });
    },
  });

  // Schedule bulk delete with undo window
  const scheduleBulkDelete = useCallback((ids: string[]) => {
    setPendingDeleteIds(prev => { const s = new Set(prev); ids.forEach(id => s.add(id)); return s; });
    const toastId = `undo-bulk-delete`;
    const timer = setTimeout(() => {
      ids.forEach(id => pendingDeleteTimers.current.delete(id));
      bulkDeleteMutation.mutate(ids);
    }, 5000);
    ids.forEach(id => pendingDeleteTimers.current.set(id, timer));
    toast(`${ids.length} project${ids.length === 1 ? "" : "s"} deleted`, {
      id: toastId,
      duration: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          clearTimeout(timer);
          ids.forEach(id => pendingDeleteTimers.current.delete(id));
          setPendingDeleteIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
          toast.dismiss(toastId);
        },
      },
    });
  }, [bulkDeleteMutation]);

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
    onError: (error) => toast.error("Failed to rename", { description: toSafeMessage(error) }),
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
    onError: (error) => toast.error("Failed to update", { description: toSafeMessage(error) }),
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
      scheduleDelete(projectToDelete.id, projectToDelete.title);
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
    scheduleBulkDelete(Array.from(selectedIds));
    setBulkDeleteDialogOpen(false);
    setSelectedIds(new Set());
  };

  const handleToggleFavorite = (project: Project, e?: React.MouseEvent) => {
    e?.stopPropagation();
    toggleFavoriteMutation.mutate({ id: project.id, is_favorite: !project.is_favorite });
  };

  const [shareLoading, setShareLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [downloadingProjectId, setDownloadingProjectId] = useState<string | null>(null);
  const [regeneratingProjectId, setRegeneratingProjectId] = useState<string | null>(null);

  /** Spawn a fresh project that copies every intake field from the
   *  source row, then route the user into the new editor with
   *  autostart=1 so the standard generation pipeline kicks off the
   *  same way the intake form does. The source row stays untouched —
   *  this is a "regenerate as a new video" not "overwrite." */
  const handleRegenerate = useCallback(async (project: Project) => {
    if (!user?.id) return;
    setRegeneratingProjectId(project.id);
    try {
      // Pull the FULL source row — Project (the trimmed list shape)
      // doesn't carry content / character / intake fields.
      const { data: src, error: srcErr } = await supabase
        .from("projects")
        .select("*")
        .eq("id", project.id)
        .single();
      if (srcErr || !src) throw new Error(srcErr?.message ?? "Source project not found");

      // Cast through `unknown` because character_images / intake_settings
      // exist as DB columns but were added after the generated types were
      // last regenerated; the generated row type is missing them. This
      // is intentional — both fields ride to the new project row.
      const srcAny = src as unknown as Record<string, unknown>;
      const cloneInsert = {
        user_id: user.id,
        title: `${src.title} (regenerated)`,
        content: src.content,
        project_type: src.project_type,
        format: src.format,
        length: src.length,
        voice_name: src.voice_name,
        voice_inclination: src.voice_inclination,
        style: src.style,
        character_description: src.character_description,
        character_consistency_enabled: src.character_consistency_enabled,
        character_images: srcAny.character_images ?? null,
        intake_settings: srcAny.intake_settings ?? {},
      };

      const { data, error } = await supabase
        .from("projects")
        .insert(cloneInsert as never)
        .select("id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "Insert returned no row");

      toast.success("New project created — kicking off generation…");
      const editorRoute = isFlagOn("UNIFIED_EDITOR")
        ? `/app/editor/${data.id}?autostart=1`
        : `/app/create?project=${data.id}&autostart=1`;
      navigate(editorRoute);
      // Invalidate so the dashboard sidebar Recent + Projects grid
      // both pick the new row up immediately if the user navigates
      // back without a full refresh.
      queryClient.invalidateQueries({ queryKey: ["all-projects"] });
      queryClient.invalidateQueries({ queryKey: ["recent-projects"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start regeneration", { description: msg });
    } finally {
      setRegeneratingProjectId(null);
    }
  }, [user?.id, navigate, queryClient]);

  const handleShare = async (project: Project) => {
    setProjectToShare(project);
    setShareUrl("");
    setShareDialogOpen(true);
    setShareLoading(true);

    try {
      if (!user?.id) throw new Error("Not authenticated");

      // Check if share already exists
      const { data: existingShare } = await supabase
        .from("project_shares")
        .select("share_token")
        .eq("project_id", project.id)
        .eq("user_id", user.id)
        .maybeSingle();

      if (existingShare?.share_token) {
        setShareUrl(`${window.location.origin}/share/${existingShare.share_token}`);
      } else {
        // Create new share token with 30-day expiry
        const shareToken = crypto.randomUUID().replace(/-/g, "");
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const { error } = await supabase.from("project_shares").insert({
          project_id: project.id,
          user_id: user.id,
          share_token: shareToken,
          expires_at: expiresAt,
        });

        if (error) throw error;
        setShareUrl(`${window.location.origin}/share/${shareToken}`);
        try { trackEvent("share_created", { project_type: project.project_type || "unknown" }); } catch { /* analytics non-critical */ }
      }
    } catch (err: unknown) {
      toast.error("Failed to create share link");
      log.error(err instanceof Error ? err.message : String(err));
    } finally {
      setShareLoading(false);
    }
  };

  const revokeShareLink = async () => {
    if (!projectToShare) return;
    try {
      await supabase.from("project_shares").delete().eq("project_id", projectToShare.id);
      setShareUrl("");
      setShareDialogOpen(false);
      toast.success("Share link revoked");
    } catch {
      toast.error("Failed to revoke share link");
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

      // If there's a pre-rendered video URL, use the cross-platform download helper
      // (handles iOS Safari share sheet, Android share, desktop blob download)
      if (generation.video_url) {
        const safeName = `${project.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;
        await downloadVideo(rewriteStorageUrl(generation.video_url), safeName, true);
        return;
      }

      // Otherwise, redirect to workspace to export
      toast.info("Redirecting to workspace to export video...");
      const mode = getCreateMode(project.project_type);
      navigate(`/app/create?mode=${mode}&project=${project.id}`);
    } catch (err: unknown) {
      toast.error("Download failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDownloadingProjectId(null);
    }
  };

  const SortIcon = sortOrder === "asc" ? SortAsc : SortDesc;

  // Toggle helper for the multi-select status chip group.
  const toggleStatus = (s: string) =>
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <AppShell breadcrumb="All projects">
      <Helmet>
        <title>Projects · MotionMax</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1480px] mx-auto">

        {/* Hero — title + tagline; stats sit beside on lg+, stack
            beneath on mobile/tablet so CREDITS USED · 30D doesn't get
            chopped at the right edge. */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="font-serif text-[28px] sm:text-[34px] lg:text-[38px] font-medium tracking-tight text-[#ECEAE4] leading-[1.05]">
            All projects
          </h1>
          <p className="text-[13px] sm:text-[14px] text-[#8A9198] mt-1.5">
            Manage, organize, and access your video library.
          </p>

          {/* Stats — 3-up grid on mobile (centered, compact), inline
              row from sm up. Using grid keeps each cell the same width
              so values don't drift around as numbers change. */}
          <div className="mt-5 grid grid-cols-3 gap-3 sm:flex sm:flex-wrap sm:gap-x-9 sm:gap-y-3 sm:mt-6">
            <Stat label="Projects" value={String(stats?.projectCount ?? '—')} />
            <Stat label="Minutes" subLabel="generated" value={stats ? stats.minutes.toFixed(1) : '—'} />
            <Stat label="Credits" subLabel="used · 30D" value={stats ? stats.creditsUsed.toLocaleString() : '—'} />
          </div>
        </motion.div>

        {/* Toolbar — search owns its own row on mobile; the dropdowns
            and view toggle drop onto a second row so nothing wraps mid
            control. Above sm everything sits on one line again. */}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#5A6268]" />
            <Input
              placeholder="Search by name, prompt, or caption…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 pl-9 pr-3 rounded-lg bg-[#10151A] border border-white/10 text-[13px] text-[#ECEAE4] placeholder:text-[#5A6268] focus-visible:ring-0 focus-visible:border-[#14C8CC]/40"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Select value={projectTypeFilter} onValueChange={setProjectTypeFilter}>
              <SelectTrigger className="h-9 flex-1 sm:flex-none sm:w-[130px] rounded-lg bg-[#10151A] border border-white/10 text-[12.5px] text-[#ECEAE4]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent className="bg-[#10151A] border-white/10">
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="doc2video"><div className="flex items-center gap-2"><Video className="h-3.5 w-3.5" />Doc2Video</div></SelectItem>
                <SelectItem value="smartflow"><div className="flex items-center gap-2"><Wallpaper className="h-3.5 w-3.5" />SmartFlow</div></SelectItem>
                <SelectItem value="cinematic"><div className="flex items-center gap-2"><Wand2 className="h-3.5 w-3.5" />Cinematic</div></SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
              <SelectTrigger className="h-9 flex-1 sm:flex-none sm:w-[120px] rounded-lg bg-[#10151A] border border-white/10 text-[12.5px] text-[#ECEAE4]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent className="bg-[#10151A] border-white/10">
                <SelectItem value="updated_at">Updated</SelectItem>
                <SelectItem value="created_at">Created</SelectItem>
                <SelectItem value="title">Title</SelectItem>
              </SelectContent>
            </Select>

            <button
              type="button"
              onClick={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
              className="h-9 w-9 shrink-0 rounded-lg bg-[#10151A] border border-white/10 grid place-items-center text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20 transition-colors"
              title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            >
              <SortIcon className="h-3.5 w-3.5" />
            </button>

            <div className="flex-1 hidden sm:block" />

            <div className="inline-flex shrink-0 rounded-lg border border-white/10 bg-[#10151A] p-[2px] gap-[2px]">
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                className={cn(
                  "h-7 w-9 rounded-md grid place-items-center transition-colors",
                  viewMode === 'grid' ? 'bg-white/10 text-[#ECEAE4]' : 'text-[#5A6268] hover:text-[#ECEAE4]',
                )}
                aria-label="Grid view"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={cn(
                  "h-7 w-9 rounded-md grid place-items-center transition-colors",
                  viewMode === 'list' ? 'bg-white/10 text-[#ECEAE4]' : 'text-[#5A6268] hover:text-[#ECEAE4]',
                )}
                aria-label="List view"
              >
                <LayoutList className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <Button variant="destructive" onClick={handleBulkDelete} className="h-9 gap-2 w-full sm:w-auto">
              <Trash2 className="h-3.5 w-3.5" />
              Delete ({selectedIds.size})
            </Button>
          )}
        </div>

        {/* Filter chips. 16:9 / 9:16 are mutually exclusive; status
            chips support multi-select. Trimmed Rendering + Has-captions
            chips per design feedback — Rendering rarely matches at the
            time the user looks (status flips quickly), and captions
            metadata isn't reliably present on every project yet. */}
        <div className="flex flex-wrap items-center gap-1.5 mt-3 mb-6">
          <Chip active={formatFilter === 'landscape'} onClick={() => setFormatFilter(formatFilter === 'landscape' ? 'all' : 'landscape')}>16:9</Chip>
          <Chip active={formatFilter === 'portrait'} onClick={() => setFormatFilter(formatFilter === 'portrait' ? 'all' : 'portrait')}>9:16</Chip>
          <ChipDot active={statusFilters.has('complete')} dot="#14C8CC" onClick={() => toggleStatus('complete')}>Published</ChipDot>
          <ChipDot active={statusFilters.has('draft')} dot="#5A6268" onClick={() => toggleStatus('draft')}>Draft</ChipDot>
          <ChipDot active={statusFilters.has('failed')} dot="#E4C875" onClick={() => toggleStatus('failed')}>Failed</ChipDot>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1,2,3,4,5,6,7,8].map(i => (
              <div key={i} className="rounded-xl border border-border/50 bg-card/50 overflow-hidden">
                <div className="h-32 bg-muted animate-pulse" />
                <div className="p-3 space-y-2">
                  <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-muted animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : projectsWithThumbnails.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title={searchQuery ? "No results found" : "No projects yet"}
            description={searchQuery ? `No projects match "${searchQuery}"` : "Create your first project to get started"}
            actionLabel={searchQuery ? "Clear search" : "Create Your First Video"}
            onAction={searchQuery ? () => { setSearchQuery(""); } : () => navigate("/app/create?mode=doc2video")}
            className="py-20"
          />
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
              onRegenerate={handleRegenerate}
              onToggleFavorite={handleToggleFavorite}
              downloadingProjectId={downloadingProjectId}
              regeneratingProjectId={regeneratingProjectId}
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
            <div className="overflow-x-auto">
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
                  <TableHead className="py-2 px-1 sm:px-3 text-xs uppercase tracking-wider text-muted-foreground/70">Title</TableHead>
                  <TableHead className="hidden md:table-cell py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground/70">Format</TableHead>
                  <TableHead className="hidden lg:table-cell py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground/70">Style</TableHead>
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
                            {project.project_type === "smartflow" || project.project_type === "smart-flow" ? (
                              <Wallpaper className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                            ) : (
                              <Video className="h-3 w-3 sm:h-4 sm:w-4 text-primary" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <span className="font-medium group-hover:text-primary transition-colors truncate block text-xs sm:text-sm">
                              {project.title}
                            </span>
                            <span className="text-xs sm:text-sm text-muted-foreground truncate block">
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
                            <Button variant="ghost" size="icon" className="h-10 w-10 sm:h-8 sm:w-8 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
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
                              className="text-destructive focus:text-destructive"
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

        {/* Footer count */}
        <div className="mt-6 font-mono text-[10px] tracking-[0.14em] uppercase text-[#5A6268]">
          {projectsWithThumbnails.length} project{projectsWithThumbnails.length !== 1 ? "s" : ""} loaded
          {selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
        </div>
      </div>
      {/* Dialogs */}

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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
            Viewers cannot download, edit, or save the project. Link expires in 30 days.
          </p>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            {shareUrl && (
              <Button variant="destructive" size="sm" onClick={revokeShareLink} className="sm:mr-auto">
                Revoke Link
              </Button>
            )}
            <Button variant="outline" onClick={() => setShareDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

/** Stat block used in the All-projects hero strip — mono uppercase
 *  label above a serif numeric value. `subLabel` lets longer labels
 *  wrap onto two short lines on mobile (e.g. MINUTES / GENERATED)
 *  instead of overflowing or shrinking type to fit. */
function Stat({ label, subLabel, value }: { label: string; subLabel?: string; value: string }) {
  return (
    <div className="flex flex-col items-start sm:items-end leading-none">
      <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase text-[#5A6268] mb-1.5 whitespace-nowrap leading-[1.3]">
        {label}
        {subLabel && <span className="block sm:inline sm:ml-1">{subLabel}</span>}
      </span>
      <span className="font-serif text-[18px] sm:text-[22px] lg:text-[24px] font-medium text-[#ECEAE4]">
        {value}
      </span>
    </div>
  );
}

/** Filter chip — neutral pill, glows teal when active. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 px-3 rounded-full font-mono text-[10px] tracking-[0.14em] uppercase border transition-colors",
        active
          ? "bg-[#14C8CC]/10 border-[#14C8CC]/40 text-[#14C8CC]"
          : "bg-[#10151A] border-white/10 text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20",
      )}
    >
      {children}
    </button>
  );
}

/** Status chip — same as Chip but with a coloured dot prefix
 *  matching the Editor's scene-status legend. `pulse` adds a heartbeat
 *  to flag actively-rendering items. */
function ChipDot({ active, dot, pulse, onClick, children }: {
  active: boolean;
  dot: string;
  pulse?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 inline-flex items-center gap-1.5 px-3 rounded-full font-mono text-[10px] tracking-[0.14em] uppercase border transition-colors",
        active
          ? "bg-white/[0.04] border-white/20 text-[#ECEAE4]"
          : "bg-[#10151A] border-white/10 text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20",
      )}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full", pulse && "animate-pulse")}
        style={{ background: dot }}
      />
      {children}
    </button>
  );
}
