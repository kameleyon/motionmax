import { useRef, useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  Download,
  Maximize,
  Volume2,
  VolumeX,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ExportState } from "@/hooks/export/types";

interface VideoPlayerProps {
  /** Export state from useVideoExport */
  exportState: ExportState;
  /** Title for the download filename */
  title: string;
  /** Download handler */
  onDownload: (url: string, filename: string, userGesture?: boolean) => void;
  /** Reset export state */
  onReset?: () => void;
  /** Retry export */
  onRetry?: () => void;
  /** Whether auto re-render is in progress (debounced) */
  isReRendering?: boolean;
  /** Additional className */
  className?: string;
}

export function VideoPlayer({
  exportState,
  title,
  onDownload,
  onReset,
  onRetry,
  isReRendering,
  className,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);

  const videoUrl = exportState.videoUrl;
  const isRendering = exportState.status === "loading" || exportState.status === "rendering" || exportState.status === "encoding";
  const isComplete = exportState.status === "complete" && !!videoUrl;
  const isError = exportState.status === "error";
  const isIdle = exportState.status === "idle";

  // Auto-play when video becomes available
  useEffect(() => {
    if (isComplete && videoRef.current) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isComplete, videoUrl]);

  // Hide controls after inactivity
  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    resetControlsTimer();
  }, [resetControlsTimer]);

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setIsMuted(videoRef.current.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!videoRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoRef.current.requestFullscreen?.();
    }
  }, []);

  const handleDownload = useCallback(() => {
    if (!videoUrl) return;
    const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";
    onDownload(videoUrl, `${safeName}.mp4`, true);
  }, [videoUrl, title, onDownload]);

  const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "video";

  return (
    <div
      className={cn(
        "relative rounded-xl overflow-hidden bg-black aspect-video",
        className,
      )}
      onMouseMove={resetControlsTimer}
      onMouseEnter={() => setShowControls(true)}
    >
      {/* ── Idle: waiting for render ── */}
      {isIdle && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/60">
          <Play className="h-16 w-16 mb-3" />
          <p className="text-sm">Video will appear here</p>
        </div>
      )}

      {/* ── Rendering progress ── */}
      {isRendering && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
          <div className="relative">
            <Loader2 className="h-12 w-12 text-primary animate-spin" />
          </div>
          <div className="text-center space-y-2 px-6 max-w-sm">
            <p className="text-sm font-medium text-white">
              {exportState.status === "loading" ? "Preparing export..." : "Rendering final video..."}
            </p>
            <Progress value={exportState.progress} className="h-2" />
            <p className="text-xs text-white/60">{exportState.progress}%</p>
            {exportState.sceneProgress?.overallMessage && (
              <p className="text-xs text-white/50">{exportState.sceneProgress.overallMessage}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Re-rendering overlay ── */}
      {isReRendering && isComplete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-20 backdrop-blur-sm">
          <div className="flex items-center gap-2 bg-black/60 px-4 py-2 rounded-full">
            <RefreshCw className="h-4 w-4 text-primary animate-spin" />
            <span className="text-sm text-white">Re-rendering...</span>
          </div>
        </div>
      )}

      {/* ── Error state ── */}
      {isError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm text-white/80 text-center px-6">{exportState.error || "Export failed"}</p>
          <div className="flex gap-2">
            {onRetry && (
              <Button size="sm" onClick={onRetry} className="gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            )}
            {onReset && (
              <Button size="sm" variant="outline" onClick={onReset}>
                Dismiss
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Video element ── */}
      {isComplete && (
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-contain"
          muted={isMuted}
          loop
          playsInline
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
      )}

      {/* ── Floating controls ── */}
      <AnimatePresence>
        {isComplete && showControls && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/20 h-8 w-8"
                  onClick={togglePlay}
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/20 h-8 w-8"
                  onClick={toggleMute}
                >
                  {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/20 h-8 w-8"
                  onClick={toggleFullscreen}
                >
                  <Maximize className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  onClick={handleDownload}
                  className="gap-1.5 bg-primary hover:bg-primary/90"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
