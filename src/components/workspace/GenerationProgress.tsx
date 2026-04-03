import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Wand2, Wallpaper, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import type { GenerationState } from "@/hooks/useGenerationPipeline";

interface SceneProgressEntry {
  sceneIndex: number;
  phase: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  message?: string;
}

interface SceneProgressData {
  totalScenes: number;
  completedScenes: number;
  currentSceneIndex: number;
  overallPhase: string;
  overallMessage: string;
  scenes: SceneProgressEntry[];
  updatedAt: string;
  etaSeconds: number;
}

interface GenerationProgressProps {
  state: GenerationState;
  /** Per-scene progress data from job payload (export phase) */
  sceneProgress?: SceneProgressData | null;
}

function SceneStatusIcon({ phase }: { phase: string }) {
  switch (phase) {
    case "complete":
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    case "failed":
    case "timeout":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "encoding":
    case "generating":
    case "downloading":
    case "uploading":
      return <Loader2 className="h-3.5 w-3.5 text-primary animate-spin" />;
    case "skipped":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function SceneProgressList({ scenes, totalScenes, completedScenes }: {
  scenes: SceneProgressEntry[];
  totalScenes: number;
  completedScenes: number;
}) {
  if (!scenes || scenes.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto">
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
        <span>Scene Progress</span>
        <span>{completedScenes}/{totalScenes} complete</span>
      </div>
      {scenes.map((scene) => (
        <motion.div
          key={scene.sceneIndex}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: scene.sceneIndex * 0.03 }}
          className="flex items-center gap-2 text-xs"
        >
          <SceneStatusIcon phase={scene.phase} />
          <span className="font-medium text-foreground min-w-[4.5rem]">
            Scene {scene.sceneIndex + 1}
          </span>
          <span className="text-muted-foreground truncate flex-1">
            {scene.message || scene.phase}
          </span>
          {scene.durationMs && scene.durationMs > 0 && (
            <span className="text-muted-foreground/70 tabular-nums">
              {formatDuration(scene.durationMs)}
            </span>
          )}
        </motion.div>
      ))}
    </div>
  );
}

export function GenerationProgress({ state, sceneProgress }: GenerationProgressProps) {
  const isSmartFlow = state.projectType === "smartflow";

  // Build verbose status message based on current step and progress
  const getStatusMessage = (): string => {
    // If we have scene progress with a meaningful overall message, prefer it during export
    if (sceneProgress?.overallMessage && state.step === "rendering") {
      return sceneProgress.overallMessage;
    }

    // If we have a custom status message from the backend, use it
    if (state.statusMessage) {
      return state.statusMessage;
    }

    const { step, progress, currentScene, sceneCount, completedImages, totalImages } = state;

    switch (step) {
      case "analysis":
        if (progress < 5) return "Starting generation...";
        if (progress < 8) return isSmartFlow ? "Analyzing your data..." : "Analyzing your content...";
        if (progress < 10) return "Generating character references...";
        return isSmartFlow ? "Preparing infographic layout..." : "Preparing script generation...";

      case "scripting":
        if (isSmartFlow) {
          if (progress < 15) return "AI is extracting key insights...";
          if (progress < 20) return "Designing infographic concept...";
          if (progress < 30) return "Crafting visual narrative...";
          return "Finalizing infographic design...";
        }
        if (progress < 15) return "AI is writing your script...";
        if (progress < 20) return "Creating scenes and dialogue...";
        if (progress < 30) return "Generating voiceover content...";
        return "Finalizing script structure...";

      case "visuals":
        if (isSmartFlow) {
          if (progress < 45) {
            return "Generating narration audio...";
          }
          return "Creating your infographic...";
        }
        if (progress < 45) {
          const audioProgress = currentScene || 1;
          return `Generating voiceover audio... (${audioProgress}/${sceneCount} scenes)`;
        }
        if (totalImages > 0 && completedImages >= 0) {
          // Get ETA from state if available
          const eta = (state as any).etaSeconds;
          if (eta && eta > 0) {
            const minutes = Math.floor(eta / 60);
            const seconds = eta % 60;
            const etaStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            return `Creating visuals... (${completedImages}/${totalImages} images, ~${etaStr} remaining)`;
          }
          return `Creating visuals... (${completedImages}/${totalImages} images)`;
        }
        return `Generating scene images... (${currentScene || 1}/${sceneCount})`;

      case "rendering":
        return isSmartFlow ? "Finalizing infographic..." : "Compiling your video...";

      case "complete":
        return "Generation complete!";

      case "error":
        return state.error || "An error occurred";

      default:
        return "Processing...";
    }
  };

  // Get step label for the header
  const getStepLabel = (): string => {
    if (isSmartFlow) {
      switch (state.step) {
        case "analysis":
          return "Step 1 of 3 • Analysis";
        case "scripting":
          return "Step 2 of 3 • Content Extraction";
        case "visuals":
          return state.progress < 45
            ? "Step 2 of 3 • Audio Generation"
            : "Step 3 of 3 • Image Generation";
        case "rendering":
          return "Step 3 of 3 • Finalizing";
        case "complete":
          return "Complete";
        default:
          return "Processing";
      }
    }

    switch (state.step) {
      case "analysis":
        return "Step 1 of 4 • Analysis";
      case "scripting":
        return "Step 2 of 4 • Script Generation";
      case "visuals":
        return state.progress < 45
          ? "Step 3 of 4 • Audio Generation"
          : "Step 3 of 4 • Image Generation";
      case "rendering":
        return "Step 4 of 4 • Finalizing";
      case "complete":
        return "Complete";
      default:
        return "Processing";
    }
  };

  // Determine if we should show the per-scene breakdown
  const showSceneBreakdown = sceneProgress && sceneProgress.scenes.length > 0 && (
    sceneProgress.scenes.some((s) => s.phase !== "pending")
  );

  // Calculate ETA display
  const etaSeconds = sceneProgress?.etaSeconds || (state as any).etaSeconds || 0;
  const etaDisplay = etaSeconds > 0
    ? etaSeconds >= 60
      ? `~${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s remaining`
      : `~${etaSeconds}s remaining`
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6 rounded-2xl border border-border/50 bg-card/50 p-8 backdrop-blur-sm max-w-lg mx-auto"
    >
      {/* Header */}
      <div className="flex items-center gap-4">
        <motion.div
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"
          animate={{ scale: state.isGenerating ? [1, 1.05, 1] : 1 }}
          transition={{ duration: 2, repeat: state.isGenerating ? Infinity : 0, ease: "easeInOut" }}
        >
          {state.isGenerating ? (
            <Loader2 className="h-6 w-6 text-primary animate-spin" />
          ) : isSmartFlow ? (
            <Wallpaper className="h-6 w-6 text-primary" />
          ) : (
            <Wand2 className="h-6 w-6 text-primary" />
          )}
        </motion.div>
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            {isSmartFlow ? "Creating Your Infographic" : "Creating Your Video"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {getStepLabel()}
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-2xl font-bold text-foreground">
            {Math.round(state.progress)}%
          </span>
          <span className="text-sm text-muted-foreground">
            {etaDisplay || (state.progress < 100 ? "In progress..." : "Done!")}
          </span>
        </div>

        <div className="h-3 overflow-hidden rounded-full bg-muted/30 relative">
          <motion.div
            className="h-full bg-gradient-to-r from-primary to-primary/70 rounded-full relative overflow-hidden"
            initial={{ width: 0 }}
            animate={{ width: `${state.progress}%` }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            {/* Subtle shimmer animation to show it's active */}
            {state.isGenerating && state.progress < 100 && (
              <motion.div
                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
                animate={{ x: ["-100%", "200%"] }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              />
            )}
          </motion.div>
        </div>
      </div>

      {/* Verbose Status */}
      <div className="rounded-lg bg-muted/20 px-4 py-3 border border-border/30">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">
            <motion.div
              className="h-2 w-2 rounded-full bg-primary"
              animate={{ opacity: state.isGenerating ? [1, 0.4, 1] : 1 }}
              transition={{ duration: 1.5, repeat: state.isGenerating ? Infinity : 0 }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {getStatusMessage()}
            </p>
            {state.step === "visuals" && state.totalImages > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                This may take a few minutes depending on the number of scenes
              </p>
            )}
          </div>
        </div>

        {/* Per-scene progress breakdown */}
        <AnimatePresence>
          {showSceneBreakdown && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
            >
              <SceneProgressList
                scenes={sceneProgress!.scenes}
                totalScenes={sceneProgress!.totalScenes}
                completedScenes={sceneProgress!.completedScenes}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
