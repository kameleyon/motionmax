import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  FolderArchive,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
  FileText,
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
import { toast } from "@/hooks/use-toast";
import { useCinematicRegeneration } from "@/hooks/useCinematicRegeneration";
import { useVideoExport } from "@/hooks/useVideoExport";
import { cn } from "@/lib/utils";
import { CinematicEditModal } from "./CinematicEditModal";
import { SceneVersionHistory } from "./SceneVersionHistory";
import { VideoPlayer } from "./VideoPlayer";
import {
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";
import JSZip from "jszip";

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
  format?: "landscape" | "portrait" | "square";
  totalTimeMs?: number;
}

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
  format = "landscape",
  totalTimeMs,
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
  const [isDownloadingClipsZip, setIsDownloadingClipsZip] = useState(false);

  const { state: exportState, exportVideo, downloadVideo, reset: resetExport } = useVideoExport();
  const reRenderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasAutoExportedRef = useRef(false);

  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  const scenesWithVideo = useMemo(() => localScenes.filter((s) => !!s.videoUrl), [localScenes]);

  // Cinematic regeneration hook
  const handleScenesUpdate = useCallback((updatedScenes: CinematicScene[]) => {
    setLocalScenes(updatedScenes);

    // Debounced auto re-render: wait 3s after last scene change
    setIsReRendering(true);
    if (reRenderTimerRef.current) clearTimeout(reRenderTimerRef.current);
    reRenderTimerRef.current = setTimeout(() => {
      setIsReRendering(false);
      clearVideoExportLogs();
      const exportScenes = updatedScenes.map((s) => ({
        number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
        duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
      }));
      void exportVideo(exportScenes, format, undefined, projectId, "cinematic").catch(() => {});
    }, 3000);
  }, [exportVideo, format, projectId]);

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

  // Auto-export on first mount
  useEffect(() => {
    if (hasAutoExportedRef.current) return;
    if (!scenesWithVideo.length || !projectId) return;
    if (exportState.status !== "idle") return;

    hasAutoExportedRef.current = true;
    clearVideoExportLogs();
    const exportScenes = localScenes.map((s) => ({
      number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
      duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
    }));
    void exportVideo(exportScenes, format, undefined, projectId, "cinematic").catch(() => {});
  }, [scenesWithVideo.length, projectId, format, exportVideo, exportState.status, localScenes]);

  // Copy script
  const copyScript = useCallback(() => {
    const script = localScenes.map((s, i) => `Scene ${s.number || i + 1}:\n${s.voiceover}`).join("\n\n");
    navigator.clipboard.writeText(script).then(
      () => toast({ title: "Script copied!" }),
      () => toast({ variant: "destructive", title: "Failed to copy" })
    );
  }, [localScenes]);

  const handleRetryExport = useCallback(() => {
    resetExport();
    clearVideoExportLogs();
    const exportScenes = localScenes.map((s) => ({
      number: s.number, voiceover: s.voiceover, visualPrompt: s.visualPrompt,
      duration: s.duration, videoUrl: s.videoUrl, audioUrl: s.audioUrl, imageUrl: s.imageUrl,
    }));
    void exportVideo(exportScenes, format, undefined, projectId, "cinematic").catch(() => {});
  }, [resetExport, exportVideo, localScenes, format, projectId]);

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
      const backendUrl = import.meta.env.VITE_SUPABASE_URL;
      setShareUrl(`${backendUrl}/functions/v1/share-meta?token=${token}&v=${Date.now()}`);
      setDisplayUrl(`https://motionmax.io/share/${token}`);
    } catch {
      toast({ title: "Failed to create share link", variant: "destructive" });
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
      toast({ title: "Project deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  }, [navigate, projectId]);

  // Download clips zip
  const handleDownloadClipsZip = useCallback(async () => {
    if (!scenesWithVideo.length) return;
    setIsDownloadingClipsZip(true);
    try {
      const zip = new JSZip();
      for (const scene of scenesWithVideo) {
        if (!scene.videoUrl) continue;
        const res = await fetch(scene.videoUrl);
        if (res.ok) zip.file(`scene-${scene.number}.mp4`, await res.blob());
        if (scene.audioUrl) {
          const audioRes = await fetch(scene.audioUrl);
          if (audioRes.ok) zip.file(`scene-${scene.number}-audio.wav`, await audioRes.blob());
        }
      }
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFileBase(title)}-clips.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({ variant: "destructive", title: "Download failed" });
    } finally {
      setIsDownloadingClipsZip(false);
    }
  }, [scenesWithVideo, title]);

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
      </div>

      {/* ── Main Split Layout ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Video Player (3/5) */}
        <div className="lg:col-span-3">
          <VideoPlayer
            exportState={exportState}
            title={title}
            onDownload={downloadVideo}
            onReset={resetExport}
            onRetry={handleRetryExport}
            isReRendering={isReRendering}
          />
        </div>

        {/* Right: Script & Controls (2/5) */}
        <div className="lg:col-span-2 space-y-4">
          {/* Script */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <FileText className="h-4 w-4 text-primary" />
                Script
              </div>
              <Button size="sm" variant="outline" onClick={copyScript} className="gap-1.5">
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-3">
              {localScenes.map((scene, idx) => (
                <div key={scene.number || idx} className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Scene {scene.number || idx + 1}</p>
                  <p className="text-sm text-foreground leading-relaxed">{scene.voiceover}</p>
                </div>
              ))}
            </div>
          </Card>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              onClick={() => setShowScenes(!showScenes)}
              className="w-full justify-between"
            >
              <span className="flex items-center gap-2">
                {showScenes ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showScenes ? "Hide Scenes" : `Edit / Adjust Scenes (${localScenes.length})`}
              </span>
              {showScenes ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadClipsZip}
                disabled={isDownloadingClipsZip || !scenesWithVideo.length} className="flex-1 gap-1.5">
                <FolderArchive className="h-3.5 w-3.5" />
                {isDownloadingClipsZip ? "..." : "Clips"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleShare} disabled={!projectId} className="flex-1 gap-1.5">
                <Link2 className="h-3.5 w-3.5" />
                Share
              </Button>
              <Button variant="outline" size="sm" onClick={onNewProject} className="flex-1 gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                New
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => setIsDeleteDialogOpen(true)} disabled={!projectId}
                className="gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
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
            toast({ title: "Version Restored", description: "Refresh to see changes" });
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
                  toast({ title: "Link copied!" });
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
              <Button variant="ghost" size="icon" onClick={() => setShowExportLogs(false)}>
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
