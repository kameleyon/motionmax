import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { Scene, CostTracking, PhaseTimings } from "@/hooks/useGenerationPipeline";
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
}

export function GenerationResult({ 
  title, 
  scenes: initialScenes, 
  format, 
  onNewProject,
  onRegenerateAll, 
  totalTimeMs, 
  costTracking,
  generationId,
  projectId,
  onScenesUpdate,
  brandMark,
}: GenerationResultProps) {
  const [scenes, setScenes] = useState(initialScenes);
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [sceneProgress, setSceneProgress] = useState(0);
  const [editingSceneIndex, setEditingSceneIndex] = useState<number | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);
  const playAllAudioRef = useRef<HTMLAudioElement | null>(null);
  const sceneAudioRef = useRef<HTMLAudioElement | null>(null);
  const imageTimerRef = useRef<NodeJS.Timeout | null>(null);

  const { state: exportState, exportVideo, downloadVideo, shareVideo, reset: resetExport } = useVideoExport();
  const { state: zipState, downloadImagesAsZip } = useImagesZipDownload();
  const shouldAutoDownloadRef = useRef(false);
  const lastAutoDownloadedUrlRef = useRef<string | null>(null);

  // Recompute on demand (e.g. after Clear) and during export progress.
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

  useEffect(() => {
    if (!shouldAutoDownloadRef.current) return;
    if (exportState.status !== "complete" || !exportState.videoUrl) return;
    if (lastAutoDownloadedUrlRef.current === exportState.videoUrl) return;

    // iOS Safari blocks non-gesture downloads; require an explicit tap on "Download Video".
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      shouldAutoDownloadRef.current = false;
      lastAutoDownloadedUrlRef.current = exportState.videoUrl;
      return;
    }

    lastAutoDownloadedUrlRef.current = exportState.videoUrl;
    shouldAutoDownloadRef.current = false;

    const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";
    downloadVideo(exportState.videoUrl, `${safeName}.mp4`);
  }, [downloadVideo, exportState.status, exportState.videoUrl, title]);

  const currentScene = scenes[currentSceneIndex];
  const currentImages = currentScene?.imageUrls && currentScene.imageUrls.length > 0 
    ? currentScene.imageUrls 
    : currentScene?.imageUrl 
      ? [currentScene.imageUrl] 
      : [];
  const displayedImageUrl = currentImages[currentImageIndex] || currentScene?.imageUrl;

  const goToNextScene = () => {
    if (currentSceneIndex < scenes.length - 1) {
      setCurrentSceneIndex(currentSceneIndex + 1);
      setCurrentImageIndex(0);
    }
  };

  const goToPrevScene = () => {
    if (currentSceneIndex > 0) {
      setCurrentSceneIndex(currentSceneIndex - 1);
      setCurrentImageIndex(0);
    }
  };

  // Image cycling timer for multi-image scenes during playback
  useEffect(() => {
    if (imageTimerRef.current) {
      clearInterval(imageTimerRef.current);
      imageTimerRef.current = null;
    }

    if (isPlayingAll && currentImages.length > 1) {
      const duration = currentScene?.duration || 10;
      const timePerImage = (duration * 1000) / currentImages.length;
      
      imageTimerRef.current = setInterval(() => {
        setCurrentImageIndex(prev => (prev + 1) % currentImages.length);
      }, timePerImage);
    }

    return () => {
      if (imageTimerRef.current) {
        clearInterval(imageTimerRef.current);
      }
    };
  }, [isPlayingAll, currentSceneIndex, currentImages.length, currentScene?.duration]);

  const stopSceneAudio = () => {
    const el = sceneAudioRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  };

  const stopPlayAll = () => {
    const el = playAllAudioRef.current;
    setIsPlayingAll(false);
    setSceneProgress(0);
    setCurrentImageIndex(0);
    if (imageTimerRef.current) {
      clearInterval(imageTimerRef.current);
      imageTimerRef.current = null;
    }
    if (el) {
      el.pause();
      el.currentTime = 0;
      el.removeAttribute("src");
      el.load();
    }
  };

  const playSceneAudio = async (index: number) => {
    stopSceneAudio();

    const el = playAllAudioRef.current;
    const scene = scenes[index];
    if (!el) return;

    // CRITICAL: Stop any currently playing audio before starting new scene
    el.pause();
    el.currentTime = 0;
    el.removeAttribute("src");
    el.load(); // Reset element completely

    setSceneProgress(0);
    setCurrentSceneIndex(index);
    setCurrentImageIndex(0);

    if (!scene?.audioUrl) {
      // Small delay before moving to next scene to prevent rapid firing
      setTimeout(() => handlePlayAllEnded(index), 100);
      return;
    }

    try {
      // Create a promise that resolves when audio is ready to play
      const audioReady = new Promise<void>((resolve, reject) => {
        const onCanPlay = () => {
          el.removeEventListener("canplaythrough", onCanPlay);
          el.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          el.removeEventListener("canplaythrough", onCanPlay);
          el.removeEventListener("error", onError);
          reject(new Error("Audio load failed"));
        };
        el.addEventListener("canplaythrough", onCanPlay, { once: true });
        el.addEventListener("error", onError, { once: true });
      });

      // Set source and wait for it to be ready
      el.src = scene.audioUrl;
      el.load();
      
      await audioReady;
      await el.play();
    } catch {
      handlePlayAllEnded(index);
    }
  };

  const startPlayAll = async (startIndex: number) => {
    stopSceneAudio();
    setIsPlayingAll(true);
    await playSceneAudio(startIndex);
  };

  const pausePlayAll = () => {
    const el = playAllAudioRef.current;
    if (el) el.pause();
    setIsPlayingAll(false);
  };

  const resumePlayAll = async () => {
    stopSceneAudio();

    const el = playAllAudioRef.current;
    if (!el) return;

    const hasActiveSrc = !!el.getAttribute("src");
    const hasProgress = Number.isFinite(el.currentTime) && el.currentTime > 0;

    if (hasActiveSrc && hasProgress) {
      try {
        await el.play();
        setIsPlayingAll(true);
        return;
      } catch {
        // fall through to restart
      }
    }

    await startPlayAll(currentSceneIndex);
  };

  const handlePlayAllEnded = async (endedIndex?: number) => {
    const idx = typeof endedIndex === "number" ? endedIndex : currentSceneIndex;
    const nextIndex = idx + 1;

    if (nextIndex >= scenes.length) {
      stopPlayAll();
      return;
    }

    await playSceneAudio(nextIndex);
  };

  useEffect(() => {
    setSceneProgress(0);
    setCurrentImageIndex(0);
  }, [currentSceneIndex]);

  useEffect(() => {
    return () => {
      stopPlayAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aspectClass =
    format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video";

  // Calculate total images for display
  const totalImages = scenes.reduce((sum, scene) => {
    const imgCount = scene.imageUrls?.length || (scene.imageUrl ? 1 : 0);
    return sum + imgCount;
  }, 0);

  return (
    <div className="space-y-8">
      <audio
        ref={playAllAudioRef}
        onEnded={() => handlePlayAllEnded()}
        onLoadedMetadata={() => {
          const el = playAllAudioRef.current;
          if (!el) return;
          const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : currentScene?.duration ?? 0;
          setSceneProgress(dur > 0 ? Math.min(1, el.currentTime / dur) : 0);
        }}
        onTimeUpdate={() => {
          const el = playAllAudioRef.current;
          if (!el) return;
          const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : currentScene?.duration ?? 0;
          setSceneProgress(dur > 0 ? Math.min(1, el.currentTime / dur) : 0);
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
        {totalTimeMs && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="flex items-center justify-center gap-4 mb-4"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/50 border border-border/50">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-foreground">
                {Math.floor(totalTimeMs / 60000)}m {Math.floor((totalTimeMs % 60000) / 1000)}s
              </span>
            </div>
          </motion.div>
        )}

        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>

        <div className="mt-4 flex items-center justify-center gap-2">
          {!isPlayingAll ? (
            <Button
              onClick={resumePlayAll}
              className="gap-2"
              disabled={!scenes.some((s) => !!s.audioUrl)}
            >
              <Play className="h-4 w-4" />
              Play Preview
            </Button>
          ) : (
            <Button onClick={pausePlayAll} className="gap-2">
              <Pause className="h-4 w-4" />
              Pause
            </Button>
          )}

          <Button variant="outline" onClick={stopPlayAll} className="gap-2" disabled={!isPlayingAll}>
            <Square className="h-4 w-4" />
            Stop
          </Button>
        </div>
      </div>

      {/* Scene Preview */}
      <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm">
        {/* Image Preview */}
        <div className={cn("relative bg-muted/50 flex items-center justify-center", aspectClass)}>
          <div className="absolute inset-x-0 top-0 z-10 h-1 bg-background/30">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${Math.round(sceneProgress * 100)}%` }}
            />
          </div>

          {/* Image indicator for multi-image scenes */}
          {currentImages.length > 1 && (
            <div className="absolute top-3 right-3 z-10 px-2 py-1 rounded bg-black/60 text-xs text-white">
              {currentImageIndex + 1} / {currentImages.length}
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {displayedImageUrl ? (
              <motion.img
                key={displayedImageUrl}
                src={displayedImageUrl}
                alt={`Scene ${currentScene?.number}`}
                loading="lazy"
                className="w-full h-full object-cover"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              />
            ) : (
              <motion.div
                key={`placeholder-${currentScene?.number ?? "none"}`}
                className="text-center text-muted-foreground"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <Play className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Scene {currentScene?.number} preview</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Scene Navigation Overlay */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="icon"
                onClick={goToPrevScene}
                disabled={currentSceneIndex === 0}
                className="text-white hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronLeft className="h-6 w-6" />
              </Button>
              
              <div className="flex items-center gap-2">
                {scenes.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setCurrentSceneIndex(idx);
                      setCurrentImageIndex(0);
                    }}
                    className={`h-2 rounded-full transition-all ${
                      idx === currentSceneIndex
                        ? "w-6 bg-white"
                        : "w-2 bg-white/40 hover:bg-white/60"
                    }`}
                  />
                ))}
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={goToNextScene}
                disabled={currentSceneIndex === scenes.length - 1}
                className="text-white hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronRight className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </div>

        {/* Scene Details */}
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">
              Scene {currentScene?.number}
              {currentImages.length > 1 && (
                <span className="text-muted-foreground ml-2 text-sm font-normal">
                  ({currentImages.length} visuals)
                </span>
              )}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{currentScene?.duration}s</span>
              <Button
                type="button"
                size="sm"
                onClick={() => setEditingSceneIndex(currentSceneIndex)}
                className="gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>
          </div>
          
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Volume2 className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                {currentScene?.voiceover}
              </p>
            </div>

            {currentScene?.audioUrl ? (
              <audio
                key={currentScene.audioUrl}
                ref={sceneAudioRef}
                controls
                preload="none"
                src={currentScene.audioUrl}
                onPlay={() => {
                  if (isPlayingAll) stopPlayAll();
                }}
                className="w-full"
              />
            ) : null}
          </div>
        </div>
      </Card>

      {/* All Scenes Grid */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-foreground">All Scenes</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {scenes.map((scene, idx) => {
            const sceneImageCount = scene.imageUrls?.length || (scene.imageUrl ? 1 : 0);
            return (
              <button
                type="button"
                key={scene.number}
                onClick={() => {
                  setCurrentSceneIndex(idx);
                  setCurrentImageIndex(0);
                }}
                className={cn(
                  "relative rounded-lg overflow-hidden border transition-all",
                  aspectClass,
                  idx === currentSceneIndex
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-border/50 hover:border-border"
                )}
              >
                {scene.imageUrl ? (
                  <img
                    src={scene.imageUrl}
                    alt={`Scene ${scene.number}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-muted/50 flex items-center justify-center">
                    <span className="text-xs text-muted-foreground">Scene {scene.number}</span>
                  </div>
                )}
                <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">
                  {scene.duration}s
                  {sceneImageCount > 1 && ` • ${sceneImageCount} imgs`}
                </div>
              </button>
            );
          })}
        </div>
      </div>

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
              {(exportState.status === "error" ||
                exportState.status === "complete") && (
                <Button type="button" variant="ghost" size="icon" onClick={resetExport}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>

            {exportState.status === "error" ? (
              <>
                <p className="text-sm text-muted-foreground">{exportState.error}</p>
                <Button
                  type="button"
                  onClick={resetExport}
                  variant="outline"
                  className="w-full mt-4"
                >
                  Close
                </Button>
              </>
            ) : exportState.status === "complete" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Your video is ready.
                </p>
                <div className="space-y-2">
                  <Button
                    type="button"
                    className="w-full gap-2"
                    onClick={() => {
                      const safeName =
                        title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";
                      downloadVideo(exportState.videoUrl!, `${safeName}.mp4`);
                    }}
                  >
                    <Download className="h-4 w-4" />
                    Download to Files
                  </Button>
                  {/* Share button for iOS Save to Photos */}
                  {typeof navigator !== "undefined" && navigator.canShare && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => {
                        const safeName =
                          title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";
                        shareVideo(exportState.videoUrl!, `${safeName}.mp4`);
                      }}
                    >
                      <Share2 className="h-4 w-4" />
                      Share / Save to Photos
                    </Button>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={resetExport}
                  className="w-full"
                >
                  Close
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>
                      {exportState.status === "loading" && "Loading assets..."}
                      {exportState.status === "rendering" &&
                        "Rendering video..."}
                      {exportState.status === "encoding" && "Encoding..."}
                    </span>
                    <span>{exportState.progress}%</span>
                  </div>
                  <Progress value={exportState.progress} className="h-2" />
                </div>

                {exportState.warning && (
                  <p className="text-xs text-muted-foreground">
                    {exportState.warning}
                  </p>
                )}

                <p className="text-xs text-muted-foreground">
                  Please keep this tab open. The video is being rendered in your
                  browser.
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
          clearVideoExportLogs();
          appendVideoExportLog("log", [
            "[UI] Export button pressed",
            {
              scenes: scenes.length,
              format,
              userAgent:
                typeof navigator !== "undefined"
                  ? navigator.userAgent.slice(0, 120)
                  : "unknown",
              isIOS:
                typeof navigator !== "undefined"
                  ? /iPad|iPhone|iPod/.test(navigator.userAgent)
                  : false,
            },
          ]);
          setExportLogsVersion((v) => v + 1);
          shouldAutoDownloadRef.current = true;
          void exportVideo(scenes, format, brandMark).catch(() => {
            setExportLogsVersion((v) => v + 1);
          });
        }}
        onDownloadImages={() => downloadImagesAsZip(scenes, title)}
        onRegenerateAll={onRegenerateAll}
        onNewProject={onNewProject}
        isExporting={
          exportState.status === "loading" ||
          exportState.status === "rendering" ||
          exportState.status === "encoding"
        }
        isDownloadingImages={
          zipState.status === "downloading" || zipState.status === "zipping"
        }
        hasImages={scenes.some((s) => !!s.imageUrl || (s.imageUrls && s.imageUrls.length > 0))}
        hasVideo={scenes.some((s) => !!s.imageUrl)}
      />

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

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(exportLogText || "");
                  } catch {
                    // ignore clipboard failures (e.g. permissions)
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
