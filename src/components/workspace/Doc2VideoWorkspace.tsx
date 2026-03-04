import { useState, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Lightbulb, Users, MessageSquareOff, Video } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContentInput } from "./ContentInput";
import { FormatSelector, type VideoFormat } from "./FormatSelector";
import { LengthSelector, type VideoLength } from "./LengthSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import { VoiceSelector, type VoiceSelection } from "./VoiceSelector";
import { PresenterFocusInput } from "./PresenterFocusInput";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { CharacterConsistencyToggle } from "./CharacterConsistencyToggle";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationResult } from "./GenerationResult";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";

export interface WorkspaceHandle {
  resetWorkspace: () => void;
  openProject: (projectId: string) => Promise<void>;
}

interface Doc2VideoWorkspaceProps {
  projectId?: string | null;
}

export const Doc2VideoWorkspace = forwardRef<WorkspaceHandle, Doc2VideoWorkspaceProps>(
  function Doc2VideoWorkspace({ projectId: initialProjectId }, ref) {
    const [content, setContent] = useState("");
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [length, setLength] = useState<VideoLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [voice, setVoice] = useState<VoiceSelection>({ type: "standard", gender: "female" });
    const [presenterFocus, setPresenterFocus] = useState("");
    const [characterDescription, setCharacterDescription] = useState("");
    const [presenterFocusOpen, setPresenterFocusOpen] = useState(false);
    const [characterDescOpen, setCharacterDescOpen] = useState(false);
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");
    const [disableExpressions, setDisableExpressions] = useState(false);
    const [characterConsistencyEnabled, setCharacterConsistencyEnabled] = useState(false);

    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();

    const canGenerate = content.trim().length > 0 && !generationState.isGenerating;

    // All formats (landscape, portrait, square) are available for short
    const disabledFormats: VideoFormat[] = [];

    // Load project if projectId provided
    useEffect(() => {
      if (initialProjectId) {
        handleOpenProject(initialProjectId);
      }
    }, [initialProjectId]);

    // Auto-recovery: if backend completes while UI is "generating" (e.g. after refresh),
    // poll the database and reload the project once it's marked complete.
    useEffect(() => {
      if (
        generationState.projectId &&
        generationState.isGenerating &&
        generationState.step !== "complete" &&
        generationState.step !== "error"
      ) {
        const checkGenerationStatus = async () => {
          const { data } = await supabase
            .from("generations")
            .select("id,status")
            .eq("project_id", generationState.projectId!)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (data?.status === "complete" && generationState.step !== "complete") {
            await loadProject(generationState.projectId!);
          }
        };

        checkGenerationStatus();
        const intervalId = setInterval(checkGenerationStatus, 5000);
        return () => clearInterval(intervalId);
      }
    }, [generationState.projectId, generationState.isGenerating, generationState.step, loadProject]);

    const runGeneration = () => {
      startGeneration({
        content,
        format,
        length,
        style,
        customStyle: style === "custom" ? customStyle : undefined,
        customStyleImage: style === "custom" ? customStyleImage : undefined,
        brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
        presenterFocus: presenterFocus.trim() ? presenterFocus.trim().slice(0, 2000) : undefined,
        characterDescription: characterDescription.trim() || undefined,
        disableExpressions,
        characterConsistencyEnabled,
        projectType: "doc2video",
        // Voice selection - pass gender for standard voices, voiceName for custom
        voiceType: voice.type,
        voiceId: voice.voiceId,
        voiceName: voice.type === "custom" ? voice.voiceName : voice.gender,
      });
    };

    const handleGenerate = () => {
      if (content.trim().length === 0) return;
      if (generationState.isGenerating) return;
      runGeneration();
    };

    const handleRetry = () => {
      if (content.trim().length === 0) return;
      reset();
      runGeneration();
    };

    const handleNewProject = () => {
      reset();
      setContent("");
      setFormat("portrait");
      setLength("brief");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setVoice({ type: "standard", gender: "female" });
      setPresenterFocus("");
      setCharacterDescription("");
      setPresenterFocusOpen(false);
      setCharacterDescOpen(false);
      setBrandMarkEnabled(false);
      setBrandMarkText("");
      setDisableExpressions(false);
      setCharacterConsistencyEnabled(false);
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setContent(project.content ?? "");

      const nextFormat = (project.format as VideoFormat) ?? "portrait";
      setFormat(["landscape", "portrait", "square"].includes(nextFormat) ? nextFormat : "portrait");

      const nextLength = (project.length as VideoLength) ?? "brief";
      setLength(["short", "brief", "presentation"].includes(nextLength) ? nextLength : "brief");

      const savedStyle = (project.style ?? "minimalist") as VisualStyle;
      if (
        savedStyle === "minimalist" ||
        savedStyle === "doodle" ||
        savedStyle === "stick" ||
        savedStyle === "anime" ||
        savedStyle === "realistic" ||
        savedStyle === "3d-pixar" ||
        savedStyle === "claymation" ||
        savedStyle === "sketch" ||
        savedStyle === "caricature" ||
        savedStyle === "storybook" ||
        savedStyle === "crayon" ||
        savedStyle === "custom"
      ) {
        setStyle(savedStyle);
        if (savedStyle !== "custom") setCustomStyle("");
      } else {
        setStyle("custom");
        setCustomStyle(project.style);
      }

      // Restore presenter focus and character description
      setPresenterFocus(project.presenter_focus ?? "");
      setCharacterDescription(project.character_description ?? "");
      
      // Expand sections if they have content
      if (project.presenter_focus) setPresenterFocusOpen(true);
      if (project.character_description) setCharacterDescOpen(true);

      // Restore voice settings
      if (project.voice_type === "custom" && project.voice_id) {
        setVoice({ 
          type: "custom", 
          voiceId: project.voice_id, 
          voiceName: project.voice_name ?? undefined 
        });
      } else {
        const gender = (project.voice_name === "male" || project.voice_name === "female") 
          ? project.voice_name 
          : "female";
        setVoice({ type: "standard", gender });
      }

      // Restore brand mark
      if (project.brand_mark) {
        setBrandMarkEnabled(true);
        setBrandMarkText(project.brand_mark);
      } else {
        setBrandMarkEnabled(false);
        setBrandMarkText("");
      }

      // Restore character consistency
      setCharacterConsistencyEnabled(project.character_consistency_enabled ?? false);
    };

    useImperativeHandle(ref, () => ({
      resetWorkspace: handleNewProject,
      openProject: handleOpenProject,
    }));

    const headerActions = generationState.step !== "idle" && generationState.step !== "complete" && generationState.step !== "error" ? (
      <motion.div
        className="flex items-center gap-2 rounded-full bg-primary/10 px-3 sm:px-4 py-1.5"
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        <span className="text-xs sm:text-sm font-medium text-primary">Generating...</span>
      </motion.div>
    ) : null;

    return (
      <WorkspaceLayout headerActions={headerActions}>
            <AnimatePresence mode="wait">
              {generationState.step === "idle" ? (
                <motion.div
                  key="input"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-2xl mx-auto space-y-6 sm:space-y-8"
                >
                  {/* Hero */}
                  <div className="text-center space-y-3">
                    <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                      <Video className="h-3.5 w-3.5" />
                      Explainer
                    </span>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                      What would you like to create?
                    </h1>
                    <p className="text-sm text-muted-foreground/70">
                      Paste your content or describe your video idea
                    </p>
                  </div>

                  {/* Content Input */}
                  <ContentInput content={content} onContentChange={setContent} />

                  {/* Collapsible Advanced Options */}
                  <div className="space-y-2 sm:space-y-3">
                    {/* Character Description - Collapsible */}
                    <Collapsible open={characterDescOpen} onOpenChange={setCharacterDescOpen}>
                      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-4 backdrop-blur-sm shadow-sm hover:bg-muted/30 transition-colors">
                        <span className="text-xs sm:text-sm font-medium flex items-center gap-2">
                          <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                          Character Appearance
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[240px]">
                              Describes the visual style of characters in the story scenes (e.g., 'Pixar style 3D characters', 'Hand-drawn sketches').
                            </TooltipContent>
                          </Tooltip>
                        </span>
                        <ChevronDown className={`h-3.5 w-3.5 sm:h-4 sm:w-4 transition-transform duration-200 ${characterDescOpen ? "rotate-180" : ""}`} />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="rounded-b-xl sm:rounded-b-2xl border border-t-0 border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm -mt-2">
                          <CharacterDescriptionInput value={characterDescription} onChange={setCharacterDescription} />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>

                    {/* Presenter Focus - Collapsible */}
                    <Collapsible open={presenterFocusOpen} onOpenChange={setPresenterFocusOpen}>
                      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-4 backdrop-blur-sm shadow-sm hover:bg-muted/30 transition-colors">
                        <span className="text-xs sm:text-sm font-medium flex items-center gap-2">
                          <Lightbulb className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                          Presenter Focus
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[240px]">
                              Describes the person speaking in the video (e.g., 'Professional news anchor', 'Friendly teacher').
                            </TooltipContent>
                          </Tooltip>
                        </span>
                        <ChevronDown className={`h-3.5 w-3.5 sm:h-4 sm:w-4 transition-transform duration-200 ${presenterFocusOpen ? "rotate-180" : ""}`} />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="rounded-b-xl sm:rounded-b-2xl border border-t-0 border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm -mt-2">
                          <PresenterFocusInput value={presenterFocus} onChange={setPresenterFocus} />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>

                    {/* Disable Expressions Toggle */}
                    <div className="flex items-center gap-2 sm:gap-3 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-4 backdrop-blur-sm shadow-sm">
                      <Checkbox
                        id="disable-expressions"
                        checked={disableExpressions}
                        onCheckedChange={(checked) => setDisableExpressions(checked === true)}
                      />
                      <label
                        htmlFor="disable-expressions"
                        className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium cursor-pointer flex-wrap"
                      >
                        <MessageSquareOff className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
                        <span>Disable voice expressions</span>
                        <span className="text-[10px] sm:text-xs text-muted-foreground/70">(no [chuckle], [sigh], etc.)</span>
                      </label>
                    </div>

                    {/* Character Consistency Toggle - Pro Feature */}
                    <CharacterConsistencyToggle
                      enabled={characterConsistencyEnabled}
                      onToggle={setCharacterConsistencyEnabled}
                    />
                  </div>

                  {/* Configuration */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-6 backdrop-blur-sm shadow-sm overflow-hidden">
                    <FormatSelector selected={format} onSelect={setFormat} disabledFormats={disabledFormats} />
                    <div className="h-px bg-border/30" />
                    
                    {/* Length and Voice side by side on desktop, stacked on mobile */}
                    <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
                      <div className="flex-1">
                        <LengthSelector selected={length} onSelect={setLength} />
                      </div>
                      <div className="sm:flex-shrink-0">
                        <VoiceSelector selected={voice} onSelect={setVoice} />
                      </div>
                    </div>
                    
                    <div className="h-px bg-border/30" />
                    <StyleSelector
                      selected={style}
                      customStyle={customStyle}
                      onSelect={setStyle}
                      onCustomStyleChange={setCustomStyle}
                      customStyleImage={customStyleImage}
                      onCustomStyleImageChange={setCustomStyleImage}
                      brandMarkEnabled={brandMarkEnabled}
                      brandMarkText={brandMarkText}
                      onBrandMarkEnabledChange={setBrandMarkEnabled}
                      onBrandMarkTextChange={setBrandMarkText}
                    />
                  </div>

                  {/* Generate Button */}
                  <motion.div whileHover={{ scale: canGenerate ? 1.01 : 1 }} whileTap={{ scale: canGenerate ? 0.99 : 1 }}>
                    <Button
                      onClick={handleGenerate}
                      disabled={!canGenerate}
                      className="w-full gap-2 sm:gap-2.5 rounded-full bg-primary py-5 sm:py-6 text-sm sm:text-base font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-40"
                    >
                      <Play className="h-4 w-4" />
                      Generate Video
                    </Button>
                  </motion.div>
                </motion.div>
              ) : generationState.step === "error" ? (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-2xl mx-auto space-y-6"
                >
                  <div className="rounded-2xl border border-primary/50 bg-primary/10 p-8 text-center">
                    <AlertCircle className="h-12 w-12 mx-auto text-primary mb-4" />
                    <h2 className="text-xl font-semibold text-foreground mb-2">Generation Failed</h2>
                    <p className="text-muted-foreground mb-6">{getUserFriendlyErrorMessage(generationState.error)}</p>
                    <Button onClick={handleRetry} variant="outline" className="gap-2">
                      <RotateCcw className="h-4 w-4" />
                      Try Again
                    </Button>
                  </div>
                </motion.div>
              ) : generationState.step === "complete" && generationState.scenes ? (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="space-y-6"
                >
                  <GenerationResult
                    title={generationState.title || "Untitled Video"}
                    scenes={generationState.scenes}
                    format={generationState.format || format}
                    onNewProject={handleNewProject}
                    onRegenerateAll={() => {
                      reset();
                      runGeneration();
                    }}
                    totalTimeMs={generationState.totalTimeMs}
                    costTracking={generationState.costTracking}
                    generationId={generationState.generationId}
                    projectId={generationState.projectId}
                    brandMark={brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="progress"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-2xl mx-auto space-y-6"
                >
                  <GenerationProgress state={generationState} />
                </motion.div>
              )}
            </AnimatePresence>
      </WorkspaceLayout>
    );
  }
);
