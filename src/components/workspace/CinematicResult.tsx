import { createScopedLogger } from "@/lib/logger";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Clock,
  Download,
  Eye,
  EyeOff,
  Film,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAdminAuth } from "@/hooks/useAdminAuth";
import { useCinematicRegeneration } from "@/hooks/useCinematicRegeneration";
import { useVideoExport } from "@/hooks/useVideoExport";
import { callPhase } from "@/hooks/generation/callPhase";
import { cn } from "@/lib/utils";
import { SUPABASE_URL } from "@/lib/supabaseUrl";
import { CinematicEditModal } from "./CinematicEditModal";
import { CaptionStyleSelector, type CaptionStyle as CaptionStyleType } from "./CaptionStyleSelector";
import { SceneVersionHistory } from "./SceneVersionHistory";
import { VideoPlayer } from "./VideoPlayer";
import {
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";

interface CinematicScene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  imageUrl?: string;
  duration: number;
}

interface CinematicResultProps {
  title: string;
  scenes: CinematicScene[];
  projectId?: string;
  generationId?: string;
  finalVideoUrl?: string;
  onNewProject: () => void;
  onRegenerate?: () => void;
  format?: "landscape" | "portrait" | "square";
  totalTimeMs?: number;
  captionStyle?: string;
  onCaptionStyleChange?: (style: string) => void;
}

const log = createScopedLogger("CinematicResult");

function safeFileBase(name: string) {
  return name.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "cinematic";
}

export function CinematicResult({
  title,
  scenes,
  projectId,
  generationId,
  finalVideoUrl,
  onNewProject,
  onRegenerate,
  format = "landscape",
  totalTimeMs,
  captionStyle: initialCaptionStyle = "none",
  onCaptionStyleChange,
}: CinematicResultProps) {
  const navigate = useNavigate();

  const [localScenes, setLocalScenes] = useState<CinematicScene[]>(scenes);
  const [showScenes, setShowScenes] = useState(false);
  const [editSceneIndex, setEditSceneIndex] = useState<number | null>(null);
  const [versionHistorySceneIndex, setVersionHistorySceneIndex] = useState<number | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);
  const [isReRendering, setIsReRendering] = useState(false);

  // Share/delete state
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [displayUrl, setDisplayUrl] = useState("");
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);

  const { state: exportState, exportVideo, downloadVideo, reset: resetExport, loadExistingVideo } = useVideoExport();
  const { isAdmin } = useAdminAuth();

  // Admin: compute full wall-clock time (generation created → export done)
  const [fullTimeMs, setFullTimeMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isAdmin || !generationId) return;
    (async () => {
      const { data: gen } = await supabase
        .from("generations")
        .select("created_at")
        .eq("id", generationId)
        .maybeSingle();
      if (!gen?.created_at) return;
      const { data: logs } = await supabase
        .from("system_logs")
        .select("created_at")
        .or(`generation_id.eq.${generationId},project_id.eq.${projectId}`)
        .order("created_at", { ascending: false })
        .limit(1);
      const lastLog = logs?.[0]?.created_at;
      if (lastLog) {
        setFullTimeMs(new Date(lastLog).getTime() - new Date(gen.created_at).getTime());
      }
    })();
  }, [isAdmin, generationId, projectId, exportState.status]);
  const hasAutoExportedRef = useRef(false);

  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  const scenesWithVideo = useMemo(() => localScenes.filter((s) => !!s.videoUrl), [localScenes]);

  // Cinematic regeneration hook — NO auto re-render.
  // User edits images/audio freely, then manually triggers render.
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);

  const handleScenesUpdate = useCallback((updatedScenes: CinematicScene[]) => {
    setLocalScenes(updatedScenes);
    setHasUnsavedEdits(true);
  }, []);

  const {
    isRegenerating,
    regenerateAudio,
    regenerateVideo,
    applyImageEdit,
    regenerateImage,
    undoRegeneration,
  } = useCinematicRegeneration(generationId, projectId, localScenes as any, handleScenesUpdate as any);

  // Keep scenes synced
  useEffect(() => { setLocalScenes(scenes); }, [scenes]);

  // On mount: use cached video if available (prop or DB), otherwise export once.
  useEffect(() => {
    if (hasAutoExportedRef.current) return;
    if (!projectId || !generationId) return;
    if (exportState.status !== "idle") return;

    hasAutoExportedRef.current = true;

    // 1. Check if the prop already carries a cached video URL (fastest path)
    if (finalVideoUrl) {
      log.debug("Using finalVideoUrl prop — skipping export");
      loadExistingVideo(finalVideoUrl);
      return;
    }

    // 2. Check the DB for a previously exported video URL
    (async () => {
      const { data: gen } = await supabase
        .from("generations")
        .select("video_url")
        .eq("id", generationId)
        .maybeSingle();

      const existingUrl = (gen as any)?.video_url;

      if (existingUrl) {
        log.debug("Existing video found in DB — skipping export");
        loadExistingVideo(existingUrl);
        return;
      }

      // 3. No cached video — trigger first-time export
      if (!scenesWithVideo.length) return;
      clearVideoExportLogs();
      const exportScenes = localScenes.map((s) => ({
        number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
        duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
      }));
      void exportVideo(exportScenes, format, undefined, projectId, "cinematic", generationId, initialCaptionStyle).catch(() => {});
    })();
  }, [projectId, generationId, finalVideoUrl, format, exportVideo, exportState.status, localScenes, scenesWithVideo.length]);

  const handleRetryExport = useCallback(() => {
    resetExport();
    clearVideoExportLogs();
    const exportScenes = localScenes.map((s) => ({
      number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
      duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
    }));
    void exportVideo(exportScenes, format, undefined, projectId, "cinematic", undefined, initialCaptionStyle).catch(() => {});
  }, [resetExport, exportVideo, localScenes, format, projectId, initialCaptionStyle]);

  // Regenerate all stale videos (missing videoUrl) then re-export
  const [isRenderingChanges, setIsRenderingChanges] = useState(false);
  const handleRenderChanges = useCallback(async () => {
    if (!generationId || !projectId) return;
    setIsRenderingChanges(true);
    setHasUnsavedEdits(false);

    try {
      // Find scenes with missing videos
      const staleIndices = localScenes
        .map((s, i) => (!s.videoUrl && s.imageUrl ? i : -1))
        .filter((i) => i >= 0);

      if (staleIndices.length > 0) {
        toast.success("Regenerating Videos", { description: `Regenerating ${staleIndices.length} video(s)...` });

        // Regenerate stale videos in batches of 4
        for (let start = 0; start < staleIndices.length; start += 4) {
          const batch = staleIndices.slice(start, start + 4);
          const results = await Promise.allSettled(
            batch.map((idx) =>
              callPhase({ phase: "video", generationId, projectId, sceneIndex: idx, regenerate: true }, 10 * 60 * 1000)
            )
          );

          // Update local scenes with new video URLs
          const updatedScenes = [...localScenes];
          for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status === "fulfilled" && r.value?.success && r.value.videoUrl) {
              updatedScenes[batch[j]] = { ...updatedScenes[batch[j]], videoUrl: r.value.videoUrl };
            }
          }
          setLocalScenes(updatedScenes);
        }
      }

      // Now re-export with all videos
      resetExport();
      clearVideoExportLogs();
      // Re-read local scenes after updates
      const freshScenes = localScenes.map((s) => ({
        number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
        duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
      }));
      await exportVideo(freshScenes, format, undefined, projectId, "cinematic", generationId, initialCaptionStyle);
    } catch (err) {
      log.error("Render changes failed:", err);
      toast.error("Render Failed", { description: (err as Error).message });
    } finally {
      setIsRenderingChanges(false);
    }
  }, [generationId, projectId, localScenes, format, resetExport, exportVideo, initialCaptionStyle]);

  // Share
  const handleShare = useCallback(async () => {
    if (!projectId) return;
    setIsShareDialogOpen(true);
    setIsCreatingShare(true);
    setHasCopied(false);
    try {
      const { data: existing } = await supabase.from("project_shares").select("share_token").eq("project_id", projectId).maybeSingle();
      let token = existing?.share_token;
      if (!token) {
        token = crypto.randomUUID();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not authenticated");
        await supabase.from("project_shares").insert({ project_id: projectId, user_id: user.id, share_token: token });
      }
      // Branded URL for users to share (resolves via SPA /share/:token route)
      const brandedUrl = `${window.location.origin}/share/${token}`;
      // Edge function URL kept for social bot previews
      const backendUrl = SUPABASE_URL;
      const shareMetaUrl = `${backendUrl}/functions/v1/share-meta?token=${token}`;
      setShareUrl(shareMetaUrl);
      setDisplayUrl(brandedUrl);
    } catch {
      toast.error("Failed to create share link");
      setIsShareDialogOpen(false);
    } finally {
      setIsCreatingShare(false);
    }
  }, [projectId]);

  // Delete
  const handleDelete = useCallback(async () => {
    if (!projectId) return;
    setIsDeleting(true);
    try {
      await supabase.from("generations").delete().eq("project_id", projectId);
      await supabase.from("project_shares").delete().eq("project_id", projectId);
      await supabase.from("project_characters").delete().eq("project_id", projectId);
      await supabase.from("projects").delete().eq("id", projectId);
      navigate("/projects", { replace: true });
      toast.success("Project deleted");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  }, [navigate, projectId]);

  const currentEditScene = editSceneIndex !== null ? localScenes[editSceneIndex] : null;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="text-center space-y-2">
        {totalTimeMs && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>Generated in {Math.floor(totalTimeMs / 60000)}m {Math.floor((totalTimeMs % 60000) / 1000)}s</span>
          </div>
        )}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
          <Film className="h-3.5 w-3.5" />
          {scenesWithVideo.length} clips
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>

        {/* Admin-only: generation stats */}
        {isAdmin && (
          <div className="inline-flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground/70 bg-muted/30 rounded-lg px-3 py-1.5 border border-border/30">
            {fullTimeMs ? (
              <span>Total: {Math.floor(fullTimeMs / 60000)}m {Math.floor((fullTimeMs % 60000) / 1000)}s</span>
            ) : totalTimeMs ? (
              <span>Gen: {Math.floor(totalTimeMs / 60000)}m {Math.floor((totalTimeMs % 60000) / 1000)}s</span>
            ) : null}
            <span>Scenes: {localScenes.length}</span>
            <span>Videos: {scenesWithVideo.length}</span>
            <span>Est. cost: ~${(
              0.02 + // OpenRouter script (~$0.02)
              localScenes.length * 0.01 + // Audio (~$0.01/scene)
              localScenes.length * 0.04 + // Images (~$0.04/scene)
              scenesWithVideo.length * 0.35 // Video ($0.35/scene Kling 10s)
            ).toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* ── Full-Width Video Player ── */}
      <div className="w-full max-w-4xl mx-auto">
        <VideoPlayer
          exportState={exportState}
          title={title}
          onDownload={downloadVideo}
          onReset={resetExport}
          onRetry={handleRetryExport}
          isReRendering={isReRendering}
          format={format}
        />
      </div>

      {/* ── Pending Changes Banner ── */}
      {hasUnsavedEdits && (
        <div className="w-full max-w-4xl mx-auto">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="text-sm text-foreground">
              You have unsaved edits. Press <strong>Render</strong> when you're done editing to regenerate affected videos and re-export.
            </p>
            <Button
              size="sm"
              onClick={handleRenderChanges}
              disabled={isRenderingChanges}
              className="h-8 gap-1.5 text-xs px-3 shrink-0"
            >
              {isRenderingChanges ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Render
            </Button>
          </div>
        </div>
      )}

      {/* ── Actions Bar ── */}
      <div className="w-full max-w-4xl mx-auto space-y-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              if (!exportState.videoUrl) return;
              downloadVideo(exportState.videoUrl, `${safeFileBase(title)}.mp4`, true);
            }}
            disabled={exportState.status !== "complete" || !exportState.videoUrl}
            className="h-8 gap-1.5 text-xs px-3"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowScenes(!showScenes)}
            className="h-8 gap-1.5 text-xs px-3"
          >
            {showScenes ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showScenes ? "Hide" : `Scenes (${localScenes.length})`}
          </Button>
          <CaptionStyleSelector
            value={(initialCaptionStyle || "none") as CaptionStyleType}
            onChange={(style) => {
              onCaptionStyleChange?.(style);
              setHasUnsavedEdits(true);
            }}
          />
          {onRegenerate && (
            <Button variant="outline" size="sm" onClick={onRegenerate} className="h-8 gap-1.5 text-xs px-3">
              <RefreshCw className="h-3.5 w-3.5" />
              Regenerate
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleShare} disabled={!projectId} className="h-8 gap-1.5 text-xs px-3">
            <Share2 className="h-3.5 w-3.5" />
            Share
          </Button>
          <Button variant="outline" size="sm"
            onClick={() => setIsDeleteDialogOpen(true)} disabled={!projectId}
            className="h-8 gap-1.5 text-xs px-3 text-muted-foreground hover:text-destructive hover:border-destructive/50">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Scenes Grid (Collapsed) ── */}
      <AnimatePresence>
        {showScenes && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <Card className="p-4 space-y-4">
              <h3 className="text-lg font-medium text-foreground">
                All Scenes ({localScenes.length})
                {isRegenerating && (
                  <span className="ml-2 text-sm text-primary">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-1" />
                    Regenerating...
                  </span>
                )}
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {localScenes.map((scene, idx) => (
                  <div key={scene.number || idx} className="space-y-2">
                    <div
                      className={cn(
                        "relative rounded-lg overflow-hidden border cursor-pointer transition-all",
                        format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video",
                      )}
                      onClick={() => setEditSceneIndex(idx)}
                    >
                      {scene.videoUrl ? (
                        <video src={scene.videoUrl} className="w-full h-full object-cover" muted playsInline preload="none" poster={scene.imageUrl} />
                      ) : scene.imageUrl ? (
                        <img src={scene.imageUrl} alt={`Scene ${scene.number}`} loading="lazy" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-muted/50 flex items-center justify-center">
                          <Film className="h-6 w-6 text-muted-foreground/50" />
                        </div>
                      )}
                      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">
                        {scene.duration}s
                      </div>
                      <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                        <Pencil className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 px-0.5">{scene.voiceover?.substring(0, 80)}...</p>
                  </div>
                ))}
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Modal */}
      {editSceneIndex !== null && currentEditScene && (
        <CinematicEditModal
          scene={currentEditScene}
          sceneIndex={editSceneIndex}
          generationId={generationId}
          format={format}
          onClose={() => setEditSceneIndex(null)}
          onRegenerateAudio={regenerateAudio}
          onRegenerateVideo={(idx) => regenerateVideo(idx)}
          onApplyImageEdit={applyImageEdit}
          onRegenerateImage={regenerateImage}
          onUndoRegeneration={undoRegeneration}
          onShowVersionHistory={(sceneIdx) => {
            setEditSceneIndex(null);
            setVersionHistorySceneIndex(sceneIdx);
          }}
          isRegenerating={!!isRegenerating && isRegenerating.sceneIndex === editSceneIndex}
          regeneratingType={isRegenerating?.sceneIndex === editSceneIndex ? isRegenerating.type : null}
        />
      )}

      {/* Version History */}
      {versionHistorySceneIndex !== null && generationId && projectId && localScenes[versionHistorySceneIndex] && (
        <SceneVersionHistory
          generationId={generationId}
          projectId={projectId}
          sceneIndex={versionHistorySceneIndex}
          sceneName={`Scene ${localScenes[versionHistorySceneIndex].number || versionHistorySceneIndex + 1}`}
          onClose={() => setVersionHistorySceneIndex(null)}
          onVersionRestored={() => {
            setVersionHistorySceneIndex(null);
            toast.success("Version Restored", { description: "Refresh to see changes" });
          }}
        />
      )}

      {/* Share Dialog */}
      <Dialog open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Cinematic</DialogTitle>
            <DialogDescription>Anyone with this link can view your video.</DialogDescription>
          </DialogHeader>
          {isCreatingShare ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Input value={displayUrl} readOnly className="flex-1 text-sm" />
                <Button onClick={async () => {
                  await navigator.clipboard.writeText(displayUrl).catch(() => {});
                  setHasCopied(true);
                  toast.success("Link copied!");
                  setTimeout(() => setHasCopied(false), 2000);
                }}>
                  {hasCopied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Deleting...</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export Logs */}
      {showExportLogs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="w-full max-w-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Export Logs</h3>
              <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setShowExportLogs(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 max-h-[60vh] overflow-auto">
              <pre className="text-xs leading-relaxed whitespace-pre-wrap">{exportLogText || "No logs."}</pre>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
