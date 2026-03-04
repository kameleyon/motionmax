import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Copy,
  Download,
  Loader2,
  Pause,
  Pencil,
  Play,
  Share2,
  Square,
  Trash2,
  Volume2,
  X,
  Clock,
  DollarSign,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { VideoFormat } from "./FormatSelector";
import type { Scene, CostTracking } from "@/hooks/useGenerationPipeline";
import { useVideoExport } from "@/hooks/useVideoExport";
import { useSceneRegeneration } from "@/hooks/useSceneRegeneration";
import { useImagesZipDownload } from "@/hooks/useImagesZipDownload";
import {
  appendVideoExportLog,
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";
import { SceneEditModal } from "./SceneEditModal";
import { ResultActionBar } from "./ResultActionBar";

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
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { state: zipState, downloadImagesAsZip } = useImagesZipDownload();

  const { state: exportState, exportVideo, downloadVideo, shareVideo, reset: resetExport } = useVideoExport();
  const shouldAutoDownloadRef = useRef(false);
  const lastAutoDownloadedUrlRef = useRef<string | null>(null);

  // Recompute on demand
  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  // Handle scenes update from regeneration
  const handleScenesUpdate = (updatedScenes: Scene[]) => {
    setScenes(updatedScenes);
    onScenesUpdate?.(updatedScenes);
  };

  const {
    isRegenerating,
    regeneratingType,
    regenerateAudio,
    regenerateImage,
  } = useSceneRegeneration(generationId, projectId, scenes, handleScenesUpdate);

  // Keep scenes in sync with prop changes
  useEffect(() => {
    setScenes(initialScenes);
  }, [initialScenes]);

  // Auto-download after export completes (except iOS)
  useEffect(() => {
    if (!shouldAutoDownloadRef.current) return;
    if (exportState.status !== "complete" || !exportState.videoUrl) return;
    if (lastAutoDownloadedUrlRef.current === exportState.videoUrl) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      shouldAutoDownloadRef.current = false;
      lastAutoDownloadedUrlRef.current = exportState.videoUrl;
      return;
    }

    lastAutoDownloadedUrlRef.current = exportState.videoUrl;
    shouldAutoDownloadRef.current = false;

    const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "infographic";
    downloadVideo(exportState.videoUrl, `${safeName}.mp4`);
  }, [downloadVideo, exportState.status, exportState.videoUrl, title]);

  // Get the single scene
  const scene = scenes[0];
  if (!scene) return null;

  const hasAudio = enableVoice && scene.audioUrl;
  const aspectClass =
    format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video";

  const stopAudio = () => {
    const el = audioRef.current;
    setIsPlaying(false);
    setAudioProgress(0);
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  };

  const playAudio = async () => {
    const el = audioRef.current;
    if (!el || !scene.audioUrl) return;

    if (isPlaying) {
      el.pause();
      setIsPlaying(false);
      return;
    }

    try {
      el.src = scene.audioUrl;
      await el.play();
      setIsPlaying(true);
    } catch {
      stopAudio();
    }
  };

  const handleDownloadImage = async () => {
    if (scene.imageUrl) {
      try {
        const response = await fetch(scene.imageUrl);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${title.replace(/\s+/g, "-").toLowerCase()}-infographic.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("Failed to download image:", error);
      }
    }
  };

  return (
    <div className="space-y-8">
      <audio
        ref={audioRef}
        onEnded={stopAudio}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (!el) return;
          const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : scene.duration ?? 0;
          setAudioProgress(dur > 0 ? Math.min(1, el.currentTime / dur) : 0);
        }}
        className="hidden"
      />

      {/* Header */}
      <div className="text-center">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 mb-4"
        >
          <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          <span className="text-sm font-medium text-primary">Generation Complete</span>
        </motion.div>

        {/* Stats Panel */}
        {(totalTimeMs || costTracking) && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex items-center justify-center gap-4 mb-4"
          >
            {totalTimeMs && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border border-border/50">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {Math.floor(totalTimeMs / 60000)}m {Math.floor((totalTimeMs % 60000) / 1000)}s
                </span>
              </div>
            )}
            {costTracking && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border border-border/50">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  ${costTracking.estimatedCostUsd.toFixed(2)}
                </span>
              </div>
            )}
          </motion.div>
        )}

        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        <p className="text-muted-foreground mt-1">
          1 scene • 1 image generated{!enableVoice && " • No audio"}
        </p>

        {/* Play Preview (only if voice enabled and audio exists) */}
        {hasAudio && (
          <div className="mt-4 flex items-center justify-center gap-2">
            <Button onClick={playAudio} className="gap-2">
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {isPlaying ? "Pause" : "Play Preview"}
            </Button>
            {isPlaying && (
              <Button variant="outline" onClick={stopAudio} className="gap-2">
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Scene Preview */}
      <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm">
        {/* Image Preview */}
        <div className={cn("relative bg-muted/50 flex items-center justify-center", aspectClass)}>
          {/* Progress bar when playing */}
          {hasAudio && (
            <div className="absolute inset-x-0 top-0 z-10 h-1 bg-background/30">
              <div
                className="h-full bg-primary transition-[width] duration-150"
                style={{ width: `${Math.round(audioProgress * 100)}%` }}
              />
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {scene.imageUrl ? (
              <motion.img
                key={scene.imageUrl}
                src={scene.imageUrl}
                alt={title}
                loading="lazy"
                className="w-full h-full object-cover"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              />
            ) : (
              <motion.div
                key="placeholder"
                className="text-center text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <Play className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Infographic preview</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Scene Details */}
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">Scene 1</h3>
            <div className="flex items-center gap-2">
              {scene.duration && (
                <span className="text-sm text-muted-foreground">{Math.ceil(scene.duration)}s</span>
              )}
              <Button
                size="sm"
                onClick={() => setEditingSceneIndex(0)}
                className="gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>
          </div>

          {/* Script & Audio (only if voice enabled) */}
          {enableVoice && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <Volume2 className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {scene.voiceover}
                </p>
              </div>

              {scene.audioUrl && (
                <audio
                  key={scene.audioUrl}
                  controls
                  preload="none"
                  src={scene.audioUrl}
                  onPlay={() => {
                    if (isPlaying) stopAudio();
                  }}
                  className="w-full"
                />
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Export Progress Modal */}
      {exportState.status !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">
                {exportState.status === "error"
                  ? "Export Failed"
                  : exportState.status === "complete"
                  ? "Export Complete!"
                  : "Exporting Video..."}
              </h3>
              {(exportState.status === "error" || exportState.status === "complete") && (
                <Button type="button" variant="ghost" size="icon" onClick={resetExport}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            {exportState.status === "error" ? (
              <>
                <p className="text-sm text-muted-foreground">{exportState.error}</p>
                <Button type="button" onClick={resetExport} variant="outline" className="w-full mt-4">
                  Close
                </Button>
              </>
            ) : exportState.status === "complete" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Your video is ready.</p>
                <div className="space-y-2">
                  <Button
                    type="button"
                    className="w-full gap-2"
                    onClick={() => {
                      const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "infographic";
                      downloadVideo(exportState.videoUrl!, `${safeName}.mp4`);
                    }}
                  >
                    <Download className="h-4 w-4" />
                    Download to Files
                  </Button>
                  {typeof navigator !== "undefined" && navigator.canShare && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => {
                        const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "infographic";
                        shareVideo(exportState.videoUrl!, `${safeName}.mp4`);
                      }}
                    >
                      <Share2 className="h-4 w-4" />
                      Share / Save to Photos
                    </Button>
                  )}
                </div>
                <Button type="button" variant="ghost" onClick={resetExport} className="w-full">
                  Close
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>
                      {exportState.status === "loading" && "Loading assets..."}
                      {exportState.status === "rendering" && "Rendering video..."}
                      {exportState.status === "encoding" && "Encoding..."}
                    </span>
                    <span>{exportState.progress}%</span>
                  </div>
                  <Progress value={exportState.progress} className="h-2" />
                </div>

                {exportState.warning && (
                  <p className="text-xs text-muted-foreground">{exportState.warning}</p>
                )}

                <p className="text-xs text-muted-foreground">
                  Please keep this tab open. The video is being rendered in your browser.
                </p>
              </>
            )}
          </Card>
        </div>
      )}

      {/* Actions */}
      <ResultActionBar
        projectId={projectId}
        generationId={generationId}
        title={title}
        scenes={scenes}
        format={format}
        onExportVideo={() => {
          if (!enableVoice) return;
          clearVideoExportLogs();
          appendVideoExportLog("log", [
            "[UI] Export button pressed",
            {
              scenes: scenes.length,
              format,
              userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : "unknown",
              isIOS: typeof navigator !== "undefined" ? /iPad|iPhone|iPod/.test(navigator.userAgent) : false,
            },
          ]);
          setExportLogsVersion((v) => v + 1);
          shouldAutoDownloadRef.current = true;
          void exportVideo(scenes, format, brandMark).catch(() => {
            setExportLogsVersion((v) => v + 1);
          });
        }}
        onDownloadImages={() => downloadImagesAsZip(scenes, title)}
        onNewProject={onNewProject}
        isExporting={
          exportState.status === "loading" ||
          exportState.status === "rendering" ||
          exportState.status === "encoding"
        }
        isDownloadingImages={
          zipState.status === "downloading" || zipState.status === "zipping"
        }
        hasImages={!!scene.imageUrl}
        hasVideo={enableVoice && !!scene.imageUrl}
      />

      {/* Export Logs Modal */}
      {showExportLogs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="w-full max-w-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">Export Logs</h3>
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowExportLogs(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(exportLogText || "");
                  } catch {
                    // ignore clipboard failures
                  }
                }}
                disabled={!exportLogText}
              >
                <Copy className="h-4 w-4" />
                Copy
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => {
                  clearVideoExportLogs();
                  setExportLogsVersion((v) => v + 1);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 max-h-[60vh] overflow-auto">
              <pre className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                {exportLogText || "No export logs captured yet."}
              </pre>
            </div>

            <p className="text-xs text-muted-foreground">
              Tip: copy these logs and paste them into chat after the export fails.
            </p>
          </Card>
        </div>
      )}

      {/* Scene Edit Modal */}
      {editingSceneIndex !== null && scenes[editingSceneIndex] && (
        <SceneEditModal
          scene={scenes[editingSceneIndex]}
          sceneIndex={editingSceneIndex}
          format={format}
          onClose={() => setEditingSceneIndex(null)}
          onRegenerateAudio={regenerateAudio}
          onRegenerateImage={regenerateImage}
          isRegenerating={isRegenerating}
          regeneratingType={regeneratingType}
        />
      )}
    </div>
  );
}
