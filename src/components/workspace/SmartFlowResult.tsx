import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  Download,
  Loader2,
  Pencil,
  Share2,
  X,
  Clock,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { VideoFormat } from "./FormatSelector";
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
import { toast } from "@/hooks/use-toast";

interface SmartFlowResultProps {
  title: string;
  scenes: Scene[];
  format: VideoFormat;
  enableVoice: boolean;
  onNewProject: () => void;
  totalTimeMs?: number;
  costTracking?: CostTracking;
  generationId?: string;
  projectId?: string;
  onScenesUpdate?: (scenes: Scene[]) => void;
  brandMark?: string;
}

export function SmartFlowResult({
  title,
  scenes: initialScenes,
  format,
  enableVoice,
  onNewProject,
  totalTimeMs,
  costTracking,
  generationId,
  projectId,
  onScenesUpdate,
  brandMark,
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

  // Handle scenes update from regeneration — debounced auto re-render
  const handleScenesUpdate = useCallback((updatedScenes: Scene[]) => {
    setScenes(updatedScenes);
    onScenesUpdate?.(updatedScenes);

    if (!enableVoice) return; // SmartFlow without voice doesn't export

    setIsReRendering(true);
    if (reRenderTimerRef.current) clearTimeout(reRenderTimerRef.current);
    reRenderTimerRef.current = setTimeout(() => {
      setIsReRendering(false);
      clearVideoExportLogs();
      void exportVideo(updatedScenes, format as any, brandMark, projectId, "smartflow", generationId).catch(() => {});
    }, 3000);
  }, [onScenesUpdate, exportVideo, format, brandMark, projectId, enableVoice, generationId]);

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

        const existingUrl = (gen as any)?.video_url;
        if (existingUrl) {
          console.log("[SmartFlowResult] Existing video found — skipping export");
          loadExistingVideo(existingUrl);
          return;
        }
      }

      clearVideoExportLogs();
      void exportVideo(initialScenes, format as any, brandMark, projectId, "smartflow", generationId).catch(() => {});
    })();
  }, [initialScenes, projectId, generationId, format, brandMark, enableVoice, exportVideo, exportState.status, loadExistingVideo]);

  const scene = scenes[0];
  if (!scene) return null;

  const handleRetryExport = () => {
    resetExport();
    clearVideoExportLogs();
    void exportVideo(scenes, format as any, brandMark, projectId, "smartflow", generationId).catch(() => {});
  };

  const copyScript = () => {
    const text = scene.voiceover || scene.title || "";
    navigator.clipboard.writeText(text).then(
      () => toast({ title: "Script copied!" }),
      () => toast({ variant: "destructive", title: "Failed to copy" })
    );
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
            "relative rounded-xl overflow-hidden bg-black",
            "aspect-video",
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
          {scene.voiceover && (
            <Button variant="outline" size="sm" onClick={copyScript} className="gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              Copy Script
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onNewProject} className="gap-1.5">
            New Project
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
