import { useRef, useState, useCallback, useEffect, useMemo } from "react";
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
import type { GenerationState } from "@/hooks/useGenerationPipeline";

// ── Fun verbose messages shown during rendering/generation ──────────
const RENDERING_MESSAGES = [
  "Mixing pixels with a dash of movie magic...",
  "Teaching frames how to dance together...",
  "Polishing every pixel to perfection...",
  "Adding the secret sauce to your scenes...",
  "Wrangling pixels into cinematic formation...",
  "Sprinkling storytelling dust on your video...",
  "Convincing scenes to play nicely together...",
  "Assembling your masterpiece frame by frame...",
  "Giving your video its final coat of awesome...",
  "Making sure every frame earns its screen time...",
  "Applying cinematic sorcery to your footage...",
  "Fine-tuning the vibe... almost there...",
  "Your video is getting its Hollywood makeover...",
  "Running the final enchantment spell...",
  "Putting the finishing touches on greatness...",
];

const GENERATION_MESSAGES: Record<string, string[]> = {
  analysis: [
    "Reading between the lines of your idea...",
    "Decoding your creative vision...",
    "Mapping out the blueprint for something epic...",
    "Analyzing the DNA of your concept...",
    "Understanding your story at a deeper level...",
  ],
  scripting: [
    "The AI screenwriter is in the zone...",
    "Crafting dialogue that hits different...",
    "Writing scenes that would make Spielberg proud...",
    "Building your narrative arc scene by scene...",
    "Cooking up a script with all the right ingredients...",
    "Weaving your story into a visual tapestry...",
  ],
  visuals: [
    "Painting your scenes with digital brushstrokes...",
    "Bringing your imagination to life, one frame at a time...",
    "The AI artist is having a creative breakthrough...",
    "Rendering visuals that pop off the screen...",
    "Creating eye candy for every scene...",
    "Turning words into stunning imagery...",
    "Each image is a small work of art...",
  ],
  rendering: [
    "Stitching it all together into pure gold...",
    "Your video is in the final stretch...",
    "Almost ready for its world premiere...",
    "Adding the final sparkle to your creation...",
    "The finish line is in sight...",
  ],
};

/** Pick a rotating message from a list based on a timer interval. */
function useRotatingMessage(messages: string[], intervalMs = 4000): string {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * messages.length));

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % messages.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [messages, intervalMs]);

  return messages[index];
}

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
  /** Video format — controls aspect ratio of player container */
  format?: "landscape" | "portrait" | "square";
  /** Additional className */
  className?: string;
  /** Generation state — when provided, shows generation progress inside the player */
  generationState?: GenerationState;
}

export function VideoPlayer({
  exportState,
  title,
  onDownload,
  onReset,
  onRetry,
  isReRendering,
  format = "landscape",
  className,
  generationState,
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

  // Determine if we're in generation mode (pipeline still running)
  const isGenerating = generationState?.isGenerating && generationState.step !== "complete" && generationState.step !== "error";

  // Pick the right message pool based on current state
  const generationStep = generationState?.step || "rendering";
  const activeMessages = useMemo(() => {
    if (isRendering) return RENDERING_MESSAGES;
    if (isGenerating) return GENERATION_MESSAGES[generationStep] || GENERATION_MESSAGES.visuals;
    return RENDERING_MESSAGES;
  }, [isRendering, isGenerating, generationStep]);

  const funMessage = useRotatingMessage(activeMessages, 4500);

  // Progress value: prefer export progress, fall back to generation progress
  const progressValue = isRendering
    ? exportState.progress
    : isGenerating
      ? generationState!.progress
      : 0;

  // Status label shown above progress bar
  const statusLabel = isRendering
    ? (exportState.status === "loading" ? "Preparing export..." : "Rendering final video...")
    : isGenerating
      ? getGenerationLabel(generationState!)
      : "Video will appear here";

  // Auto-play when video becomes available (desktop only — mobile auto-play causes memory crashes)
  const isMobileDevice = typeof navigator !== "undefined" && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  useEffect(() => {
    if (isComplete && videoRef.current && !isMobileDevice) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isComplete, videoUrl, isMobileDevice]);

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

  // Should we show the progress overlay?
  const showProgress = isRendering || (isGenerating && !isComplete);

  return (
    <div className={cn("flex justify-center", className)}>
      <div
        className={cn(
          "relative rounded-xl overflow-hidden bg-black",
          format === "portrait"  && "h-[700px] aspect-[9/16]",
          format === "square"    && "h-[700px] aspect-square",
          format === "landscape" && "w-full h-[700px]",
        )}
        onMouseMove={resetControlsTimer}
        onMouseEnter={() => setShowControls(true)}
      >
      {/* ── Idle: waiting for render ── */}
      {isIdle && !isGenerating && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground/60">
          <Play className="h-16 w-16 mb-3" />
          <p className="text-sm">Video will appear here</p>
        </div>
      )}

      {/* ── Rendering / Generation progress ── */}
      {showProgress && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
          <div className="relative">
            <Loader2 className="h-12 w-12 text-primary animate-spin" />
          </div>
          <div className="text-center space-y-2 px-6">
            <p className="text-sm font-medium text-white">
              {statusLabel}
            </p>
            <div className="w-64 mx-auto">
              <Progress value={progressValue} className="h-2" />
            </div>
            <p className="text-xs text-white/60">{Math.round(progressValue)}%</p>
            {/* Fun rotating message — fixed height to prevent layout shifts */}
            <div className="h-5 flex items-center justify-center">
              <motion.p
                key={funMessage}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.6 }}
                className="text-xs text-white/75 italic"
              >
                {funMessage}
              </motion.p>
            </div>
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
          loop={!isMobileDevice}
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
                  aria-label={isMuted ? "Unmute" : "Mute"} onClick={toggleMute}
                >
                  {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-white hover:bg-white/20 h-8 w-8"
                  aria-label="Fullscreen" onClick={toggleFullscreen}
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function getGenerationLabel(state: GenerationState): string {
  // Prefer the pipeline's own statusMessage when available — it has the most accurate counts
  if (state.statusMessage && state.step !== "complete" && state.step !== "error") {
    return state.statusMessage;
  }
  switch (state.step) {
    case "analysis": return "Analyzing your content...";
    case "scripting": return "Writing your script...";
    case "visuals":
      if (state.progress < 45) return "Generating audio...";
      if (state.totalImages > 0 && state.completedImages >= 0) {
        return `Creating visuals (${state.completedImages}/${state.totalImages})...`;
      }
      return "Generating visuals...";
    case "rendering": return "Compiling your video...";
    default: return "Processing...";
  }
}
