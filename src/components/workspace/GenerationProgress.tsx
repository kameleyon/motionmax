import { motion } from "framer-motion";
import { Loader2, Wand2, Wallpaper } from "lucide-react";
import type { GenerationState } from "@/hooks/useGenerationPipeline";

interface GenerationProgressProps {
  state: GenerationState;
}

export function GenerationProgress({ state }: GenerationProgressProps) {
  const isSmartFlow = state.projectType === "smartflow";
  
  // Build verbose status message based on current step and progress
  const getStatusMessage = (): string => {
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
          return `Creating visuals... (${completedImages}/${totalImages} images)`;
        }
        return `Generating scene images... (${currentScene}/${sceneCount})`;
      
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
            {state.progress < 100 ? "In progress..." : "Done!"}
          </span>
        </div>
        
        <div className="h-3 overflow-hidden rounded-full bg-muted/30">
          <motion.div
            className="h-full bg-gradient-to-r from-primary to-primary/70 rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${state.progress}%` }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />
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
      </div>
    </motion.div>
  );
}
