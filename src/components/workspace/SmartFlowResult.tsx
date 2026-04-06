import { createScopedLogger } from "@/lib/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Download,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  X,
  Clock,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { VideoFormat } from "@/types/domain";
import type { Scene, CostTracking } from "@/hooks/useGenerationPipeline";
import { useVideoExport } from "@/hooks/useVideoExport";
import { supabase } from "@/integrations/supabase/client";
import { useSceneRegeneration } from "@/hooks/useSceneRegeneration";
import { useImagesZipDownload } from "@/hooks/useImagesZipDownload";
import {
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";
import { SceneEditModal } from "./SceneEditModal";
import { VideoPlayer } from "./VideoPlayer";
import { toast } from "sonner";

const log = createScopedLogger("SmartFlowResult");

interface SmartFlowResultProps {
  title: string;
  scenes: Scene[];
  format: VideoFormat;
  enableVoice: boolean;
  onNewProject: () => void;
  onRegenerate?: () => void;
  totalTimeMs?: number;
  costTracking?: CostTracking;
  generationId?: string;
  projectId?: string;
  onScenesUpdate?: (scenes: Scene[]) => void;
  brandMark?: string;
  captionStyle?: string;
}

export function SmartFlowResult({
  title,
  scenes: initialScenes,
  format,
  enableVoice,
  onNewProject,
  onRegenerate,
  totalTimeMs,
  costTracking,
  generationId,
  projectId,
  onScenesUpdate,
  brandMark,
  captionStyle,
}: SmartFlowResultProps) {
  const [scenes, setScenes] = useState(initialScenes);
  const [showScenes, setShowScenes] = useState(false);
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);
  const [isReRendering, setIsReRendering] = useState(false);

  const { state: exportState, exportVideo, downloadVideo, shareVideo, reset: resetExport, loadExistingVideo } = useVideoExport();
  const { state: zipState, downloadImagesAsZip } = useImagesZipDownload();
  const reRenderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasAutoExportedRef = useRef(false);

  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  // Handle scenes update — NO auto re-render
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);

  const handleScenesUpdate = useCallback((updatedScenes: Scene[]) => {
    setScenes(updatedScenes);
    onScenesUpdate?.(updatedScenes);
    if (enableVoice) setHasUnsavedEdits(true);
  }, [onScenesUpdate, enableVoice]);

  const handleRenderChanges = useCallback(() => {
    setHasUnsavedEdits(false);
    resetExport();
    clearVideoExportLogs();
    void exportVideo(scenes, format, brandMark, projectId, "smartflow", generationId, captionStyle).catch((err) => {
      log.error("Export failed:", err);
      toast.error("Export failed", { description: err?.message || "Please try again" });
    });
  }, [resetExport, exportVideo, scenes, format, brandMark, projectId, generationId, captionStyle]);

  const {
    isRegenerating,
    regeneratingType,
    regenerateAudio,
    regenerateImage,
  } = useSceneRegeneration(generationId, projectId, scenes, handleScenesUpdate);

  useEffect(() => {
    setScenes(initialScenes);
  }, [initialScenes]);

  // On mount: check for existing rendered video, or auto-export
  useEffect(() => {
    if (hasAutoExportedRef.current) return;
    if (!enableVoice) return;
    if (!initialScenes.length || !projectId) return;
    if (exportState.status !== "idle") return;

    hasAutoExportedRef.current = true;

    (async () => {
      if (generationId) {
        const { data: gen } = await supabase
          .from("generations")
          .select("video_url")
          .eq("id", generationId)
          .maybeSingle();

        const existingUrl = (gen as { video_url?: string } | null)?.video_url;
        if (existingUrl) {
          log.debug("Existing video found — skipping export");
          loadExistingVideo(existingUrl);
          return;
        }
      }

      clearVideoExportLogs();
      void exportVideo(initialScenes, format, brandMark, projectId, "smartflow", generationId, captionStyle).catch((err) => {
      log.error("Export failed:", err);
      toast.error("Export failed", { description: err?.message || "Please try again" });
    });
    })();
  }, [initialScenes, projectId, generationId, format, brandMark, enableVoice, exportVideo, exportState.status, loadExistingVideo, captionStyle]);

  const scene = scenes[0];
  if (!scene) return null;

  const handleRetryExport = () => {
    resetExport();
    clearVideoExportLogs();
    void exportVideo(scenes, format, brandMark, projectId, "smartflow", generationId, captionStyle).catch((err) => {
      log.error("Export failed:", err);
      toast.error("Export failed", { description: err?.message || "Please try again" });
    });
  };


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
      </div>

      {/* ── Full-Width Video / Image ── */}
      <div className="w-full max-w-4xl mx-auto">
        {enableVoice ? (
          <VideoPlayer
            exportState={exportState}
            title={title}
            onDownload={downloadVideo}
            onReset={resetExport}
            onRetry={handleRetryExport}
            isReRendering={isReRendering}
            format={format as "landscape" | "portrait" | "square"}
          />
        ) : (
          /* No-voice SmartFlow: show the infographic image directly */
          <div className={cn(
            "relative rounded-xl overflow-hidden bg-black mx-auto",
            format === "portrait"  && "h-[28rem] aspect-[9/16]",
            format === "square"    && "h-[28rem] aspect-square",
            (format === "landscape" || !format) && "w-full aspect-video",
          )}>
            {scene.imageUrl ? (
              <img
                src={scene.imageUrl}
                alt={title}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                No image
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Pending Changes Banner ── */}
      {hasUnsavedEdits && (
        <div className="w-full max-w-4xl mx-auto">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="text-sm text-foreground">
              You have unsaved edits. Press <strong>Render</strong> to re-export your video with the changes.
            </p>
            <Button size="sm" onClick={handleRenderChanges} className="gap-1.5 shrink-0">
              <RefreshCw className="h-4 w-4" />
              Render
            </Button>
          </div>
        </div>
      )}

      {/* ── Actions Bar ── */}
      <div className="w-full max-w-4xl mx-auto space-y-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {enableVoice && (
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
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowScenes(!showScenes)}
            className="gap-1.5"
          >
            {showScenes ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showScenes ? "Hide Scene" : "Edit / Adjust Scene"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadImagesAsZip(scenes, title)}
            disabled={zipState.status === "downloading" || zipState.status === "zipping"}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {zipState.status === "downloading" || zipState.status === "zipping" ? "..." : "Image"}
          </Button>
          {onRegenerate && (
            <Button variant="outline" size="sm" onClick={onRegenerate} className="gap-1.5">
              <RefreshCw className="h-4 w-4" />
              Regenerate
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (exportState.videoUrl) {
                navigator.clipboard.writeText(exportState.videoUrl).then(
                  () => toast.success("Link copied!"),
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
        </div>
      </div>

      {/* ── Scene Edit (Collapsed by default) ── */}
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
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-medium text-foreground">Scene Editor</h3>
                {isRegenerating && (
                  <span className="text-sm text-primary">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-1" />
                    Regenerating...
                  </span>
                )}
              </div>

              <div className={cn(
                "relative rounded-lg overflow-hidden border cursor-pointer",
                format === "portrait" ? "aspect-[9/16] max-w-xs" : format === "square" ? "aspect-square max-w-sm" : "aspect-video max-w-lg",
              )} onClick={() => setEditingSceneIndex(0)}>
                {scene.imageUrl ? (
                  <img src={scene.imageUrl} alt={title} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-muted/50 flex items-center justify-center">
                    <span className="text-muted-foreground">No image</span>
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
                  <Pencil className="h-6 w-6 text-white" />
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

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
          isRegenerating={isRegenerating}
          regeneratingType={regeneratingType}
        />
      )}

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
              <pre className="text-xs leading-relaxed whitespace-pre-wrap">
                {exportLogText || "No logs."}
              </pre>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
