import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  Download,
  Loader2,
  Pencil,
  Trash2,
  Volume2,
  X,
  Clock,
  Eye,
  EyeOff,
  Share2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Scene, CostTracking, PhaseTimings } from "@/hooks/useGenerationPipeline";
import { useVideoExport } from "@/hooks/useVideoExport";
import { supabase } from "@/integrations/supabase/client";
import { useSceneRegeneration } from "@/hooks/useSceneRegeneration";
import { useImagesZipDownload } from "@/hooks/useImagesZipDownload";
import {
  appendVideoExportLog,
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";
import { SceneEditModal } from "./SceneEditModal";
import { SceneVersionHistory } from "./SceneVersionHistory";
import { VideoPlayer } from "./VideoPlayer";
import { toast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/hooks/useAdminAuth";

interface GenerationResultProps {
  title: string;
  scenes: Scene[];
  format: "landscape" | "portrait" | "square";
  onNewProject: () => void;
  onRegenerateAll?: () => void;
  totalTimeMs?: number;
  costTracking?: CostTracking;
  generationId?: string;
  projectId?: string;
  onScenesUpdate?: (scenes: Scene[]) => void;
  brandMark?: string;
  projectType?: string;
}

export function GenerationResult({
  title,
  scenes: initialScenes,
  format,
  onNewProject,
  totalTimeMs,
  costTracking,
  generationId,
  projectId,
  onScenesUpdate,
  brandMark,
  projectType = "storytelling",
}: GenerationResultProps) {
  const [scenes, setScenes] = useState(initialScenes);
  const [showScenes, setShowScenes] = useState(false);
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  const [versionHistorySceneIndex, setVersionHistorySceneIndex] = useState<number | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);
  const [isReRendering, setIsReRendering] = useState(false);

  const { state: exportState, exportVideo, downloadVideo, shareVideo, reset: resetExport, loadExistingVideo } = useVideoExport();
  const { isAdmin } = useAdminAuth();
  const { state: zipState, downloadImagesAsZip } = useImagesZipDownload();
  const reRenderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasAutoExportedRef = useRef(false);

  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  // Handle scenes update from regeneration
  const handleScenesUpdate = useCallback((updatedScenes: Scene[]) => {
    setScenes(updatedScenes);
    onScenesUpdate?.(updatedScenes);

    // Debounced auto re-render: wait 3s after last change
    setIsReRendering(true);
    if (reRenderTimerRef.current) clearTimeout(reRenderTimerRef.current);
    reRenderTimerRef.current = setTimeout(() => {
      setIsReRendering(false);
      clearVideoExportLogs();
      void exportVideo(updatedScenes, format, brandMark, projectId, projectType, generationId).catch(() => {});
    }, 3000);
  }, [onScenesUpdate, exportVideo, format, brandMark, projectId, projectType, generationId]);

  const {
    isRegenerating,
    regeneratingType,
    regenerateAudio,
    regenerateImage,
    undoRegeneration,
  } = useSceneRegeneration(generationId, projectId, scenes, handleScenesUpdate);

  // Keep scenes in sync with prop changes
  useEffect(() => {
    setScenes(initialScenes);
  }, [initialScenes]);

  // On mount: check for existing rendered video, or auto-export
  useEffect(() => {
    if (hasAutoExportedRef.current) return;
    if (!initialScenes.length || !projectId) return;
    if (exportState.status !== "idle") return;

    hasAutoExportedRef.current = true;

    (async () => {
      // Check for existing exported video
      if (generationId) {
        const { data: gen } = await supabase
          .from("generations")
          .select("video_url")
          .eq("id", generationId)
          .maybeSingle();

        const existingUrl = (gen as any)?.video_url;
        if (existingUrl) {
          console.log("[GenerationResult] Existing video found — skipping export");
          loadExistingVideo(existingUrl);
          return;
        }
      }

      // No existing video — trigger export
      clearVideoExportLogs();
      appendVideoExportLog("log", ["[UI] Auto-export triggered on completion"]);
      void exportVideo(initialScenes, format, brandMark, projectId, projectType, generationId).catch(() => {});
    })();
  }, [initialScenes, projectId, generationId, format, brandMark, projectType, exportVideo, exportState.status, loadExistingVideo]);

  // Copy script to clipboard
  const copyScript = useCallback(() => {
    const script = scenes
      .map((s, i) => `Scene ${s.number || i + 1}:\n${s.voiceover}`)
      .join("\n\n");
    navigator.clipboard.writeText(script).then(
      () => toast({ title: "Script copied!" }),
      () => toast({ variant: "destructive", title: "Failed to copy" })
    );
  }, [scenes]);

  const handleRetryExport = useCallback(() => {
    resetExport();
    clearVideoExportLogs();
    void exportVideo(scenes, format, brandMark, projectId, projectType, generationId).catch(() => {});
  }, [resetExport, exportVideo, scenes, format, brandMark, projectId, projectType, generationId]);

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
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>

        {/* Admin-only: generation stats */}
        {isAdmin && (
          <div className="inline-flex flex-wrap items-center justify-center gap-3 text-xs text-muted-foreground/70 bg-muted/30 rounded-lg px-3 py-1.5 border border-border/30">
            {totalTimeMs && (
              <span>Time: {Math.floor(totalTimeMs / 60000)}m {Math.floor((totalTimeMs % 60000) / 1000)}s</span>
            )}
            <span>Scenes: {scenes.length}</span>
            {costTracking && (
              <>
                <span>Images: {costTracking.imagesGenerated}</span>
                <span>Audio: {costTracking.audioSeconds.toFixed(0)}s</span>
                <span>Est. cost: ~${costTracking.estimatedCostUsd.toFixed(2)}</span>
              </>
            )}
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

      {/* ── Actions Bar ── */}
      <div className="w-full max-w-4xl mx-auto space-y-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              if (!exportState.videoUrl) return;
              const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";
              downloadVideo(exportState.videoUrl, `${safeName}.mp4`, true);
            }}
            disabled={exportState.status !== "complete" || !exportState.videoUrl}
            className="gap-1.5"
          >
            <Download className="h-4 w-4" />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowScenes(!showScenes)}
            className="gap-1.5"
          >
            {showScenes ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showScenes ? "Hide Scenes" : `Edit / Adjust Scenes (${scenes.length})`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadImagesAsZip(scenes, title)}
            disabled={zipState.status === "downloading" || zipState.status === "zipping"}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {zipState.status === "downloading" || zipState.status === "zipping" ? "..." : "Images"}
          </Button>
          <Button variant="outline" size="sm" onClick={copyScript} className="gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            Copy Script
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (exportState.videoUrl) {
                navigator.clipboard.writeText(exportState.videoUrl).then(
                  () => toast({ title: "Video link copied!" }),
                  () => {}
                );
              }
            }}
            disabled={!exportState.videoUrl}
            className="gap-1.5"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </Button>
          <Button variant="outline" size="sm" onClick={onNewProject} className="gap-1.5">
            New Project
          </Button>
        </div>
      </div>

      {/* ── Scenes Grid (Collapsed by default) ── */}
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
                All Scenes ({scenes.length})
                {isRegenerating && (
                  <span className="ml-2 text-sm text-primary">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-1" />
                    Regenerating {regeneratingType}...
                  </span>
                )}
              </h3>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {scenes.map((scene, idx) => {
                  const sceneImageCount = scene.imageUrls?.length || (scene.imageUrl ? 1 : 0);
                  return (
                    <div key={scene.number || idx} className="space-y-2">
                      {/* Thumbnail */}
                      <div
                        className={cn(
                          "relative rounded-lg overflow-hidden border cursor-pointer transition-all",
                          format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video",
                        )}
                        onClick={() => setEditingSceneIndex(idx)}
                      >
                        {scene.imageUrl ? (
                          <img
                            src={scene.imageUrl}
                            alt={`Scene ${scene.number}`}
                            loading="lazy"
                            decoding="async"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full bg-muted/50 flex items-center justify-center">
                            <span className="text-xs text-muted-foreground">Scene {scene.number}</span>
                          </div>
                        )}
                        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">
                          {scene.duration}s
                          {sceneImageCount > 1 && ` • ${sceneImageCount}`}
                        </div>
                        <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                          <Pencil className="h-5 w-5 text-white" />
                        </div>
                      </div>

                      {/* Scene info */}
                      <p className="text-xs text-muted-foreground line-clamp-2 px-0.5">
                        {scene.voiceover?.substring(0, 80)}...
                      </p>
                    </div>
                  );
                })}
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Export Logs Modal */}
      {showExportLogs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="w-full max-w-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">Export Logs</h3>
              <Button variant="ghost" size="icon" onClick={() => setShowExportLogs(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => navigator.clipboard.writeText(exportLogText || "").catch(() => {})}
                disabled={!exportLogText}
              >
                <Copy className="h-4 w-4" /> Copy
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => { clearVideoExportLogs(); setExportLogsVersion((v) => v + 1); }}
              >
                <Trash2 className="h-4 w-4" /> Clear
              </Button>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3 max-h-[60vh] overflow-auto">
              <pre className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                {exportLogText || "No export logs captured yet."}
              </pre>
            </div>
          </Card>
        </div>
      )}

      {/* Scene Edit Modal */}
      {editingSceneIndex !== null && scenes[editingSceneIndex] && (
        <SceneEditModal
          scene={scenes[editingSceneIndex]}
          sceneIndex={editingSceneIndex}
          generationId={generationId}
          format={format}
          onClose={() => setEditingSceneIndex(null)}
          onRegenerateAudio={regenerateAudio}
          onRegenerateImage={regenerateImage}
          onUndoRegeneration={undoRegeneration}
          onShowVersionHistory={(sceneIdx) => {
            setEditingSceneIndex(null);
            setVersionHistorySceneIndex(sceneIdx);
          }}
          isRegenerating={isRegenerating}
          regeneratingType={regeneratingType}
        />
      )}

      {/* Version History Modal */}
      {versionHistorySceneIndex !== null && generationId && projectId && scenes[versionHistorySceneIndex] && (
        <SceneVersionHistory
          generationId={generationId}
          projectId={projectId}
          sceneIndex={versionHistorySceneIndex}
          sceneName={`Scene ${scenes[versionHistorySceneIndex].number || versionHistorySceneIndex + 1}`}
          onClose={() => setVersionHistorySceneIndex(null)}
          onVersionRestored={() => {
            setVersionHistorySceneIndex(null);
            toast({ title: "Version Restored", description: "Please refresh to see the changes" });
          }}
        />
      )}
    </div>
  );
}
