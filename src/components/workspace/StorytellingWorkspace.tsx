import { useState, forwardRef, useImperativeHandle, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Clapperboard } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StoryIdeaInput } from "./StoryIdeaInput";
import { FormatSelector, type VideoFormat } from "./FormatSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import { VoiceSelector, type VoiceSelection } from "./VoiceSelector";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { InspirationSelector, type InspirationStyle } from "./InspirationSelector";
import { ToneSelector, type StoryTone } from "./ToneSelector";
import { GenreSelector, type StoryGenre } from "./GenreSelector";
import { InclinationSelector } from "./InclinationSelector";
import { StorytellingLengthSelector, type StoryLength } from "./StorytellingLengthSelector";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationResult } from "./GenerationResult";
import { CharacterConsistencyToggle } from "./CharacterConsistencyToggle";
import { CharacterPreview, type CharacterData } from "./CharacterPreview";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";

import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess, getCreditsRequired, PLAN_LIMITS } from "@/hooks/useSubscription";
import { useToast } from "@/hooks/use-toast";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import type { WorkspaceHandle } from "./Doc2VideoWorkspace";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";

interface StorytellingWorkspaceProps {
  projectId?: string | null;
}

export const StorytellingWorkspace = forwardRef<WorkspaceHandle, StorytellingWorkspaceProps>(
  function StorytellingWorkspace({ projectId: initialProjectId }, ref) {
    // Story-specific inputs
    const [storyIdea, setStoryIdea] = useState("");
    const [inspiration, setInspiration] = useState<InspirationStyle>("none");
    const [tone, setTone] = useState<StoryTone>("casual");
    const [genre, setGenre] = useState<StoryGenre>("documentary");
    const [disableVoiceExpressions, setDisableVoiceExpressions] = useState(false);
    const [brandName, setBrandName] = useState("");
    const [characterConsistencyEnabled, setCharacterConsistencyEnabled] = useState(false);
    
    // Shared inputs
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [length, setLength] = useState<StoryLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [voice, setVoice] = useState<VoiceSelection>({ type: "standard", gender: "female" });
    const [characterDescription, setCharacterDescription] = useState("");
    const [characterDescOpen, setCharacterDescOpen] = useState(false);
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");

    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();
    const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId, generationState.step);

    // Subscription and plan validation  
    const { plan, creditsBalance, subscriptionStatus, checkSubscription } = useSubscription();
    const { toast } = useToast();
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);
    const [upgradeReason, setUpgradeReason] = useState("");
    const [showSuspendedModal, setShowSuspendedModal] = useState(false);
    const [suspendedStatus, setSuspendedStatus] = useState<"past_due" | "unpaid" | "canceled">("past_due");

    const canGenerate = storyIdea.trim().length > 0 && !generationState.isGenerating;

    // Get disabled formats based on plan (free users can only use landscape)
    const limits = PLAN_LIMITS[plan];
    const disabledFormats: VideoFormat[] = (["landscape", "portrait", "square"] as VideoFormat[]).filter(
      f => !limits.allowedFormats.includes(f)
    );
    
    // Auto-switch to allowed format if current format becomes disabled
    useEffect(() => {
      if (disabledFormats.includes(format) && limits.allowedFormats.length > 0) {
        setFormat(limits.allowedFormats[0] as VideoFormat);
      }
    }, [plan, format, disabledFormats, limits.allowedFormats]);

    // Load project if projectId provided
    useEffect(() => {
      if (initialProjectId) {
        handleOpenProject(initialProjectId);
      }
    }, [initialProjectId]);

    // Auto-recovery: if we're in a "generating" state but the generation actually completed
    // (e.g., after page reload/rebuild), poll the database to verify and restore complete state
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
            .select("id,status,progress,scenes,error_message")
            .eq("project_id", generationState.projectId!)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          // If database says complete but UI shows generating, reload the project
          if (data?.status === "complete" && generationState.step !== "complete") {
            console.log("[StorytellingWorkspace] Found completed generation in DB, reloading project");
            await loadProject(generationState.projectId!);
          }
        };

        // Check immediately
        checkGenerationStatus();

        // Also set up a periodic check every 5 seconds while "generating"
        const intervalId = setInterval(checkGenerationStatus, 5000);
        return () => clearInterval(intervalId);
      }
    }, [generationState.projectId, generationState.isGenerating, generationState.step, loadProject]);

    const handleGenerate = async () => {
      if (!canGenerate) return;

      // Check for subscription issues first
      if (subscriptionStatus === "past_due" || subscriptionStatus === "unpaid") {
        setSuspendedStatus(subscriptionStatus as "past_due" | "unpaid");
        setShowSuspendedModal(true);
        return;
      }

      // Map storytelling UI length → backend length parameter.
      // "extended" maps to "presentation" because the backend uses doc2video length names.
      const lengthMap: Record<StoryLength, string> = {
        short: "short",
        brief: "brief",
        extended: "presentation", // "Extended (< 15 min)" → backend's "presentation" tier
      };
      const mappedLength = lengthMap[length];

      // Validate plan access
      const validation = validateGenerationAccess(
        plan,
        creditsBalance,
        "storytelling",
        mappedLength,
        format,
        brandMarkEnabled && brandMarkText.trim().length > 0,
        style === "custom",
        subscriptionStatus || undefined
      );

      if (!validation.canGenerate) {
        toast({
          variant: "destructive",
          title: "Cannot Generate",
          description: validation.error,
        });
        setUpgradeReason(validation.error || "Please upgrade your plan to continue.");
        setShowUpgradeModal(true);
        return;
      }

      startGeneration({
        content: storyIdea,
        format,
        length: mappedLength,
        style,
        customStyle: style === "custom" ? customStyle : undefined,
        customStyleImage: style === "custom" ? customStyleImage : undefined,
        brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
        characterDescription: characterDescription.trim() || undefined,
        projectType: "storytelling",
        inspirationStyle: inspiration !== "none" ? inspiration : undefined,
        storyTone: tone,
        storyGenre: genre,
        disableExpressions: disableVoiceExpressions,
        brandName: brandName.trim() || undefined,
        characterConsistencyEnabled,
        voiceType: voice.type,
        voiceId: voice.voiceId,
        voiceName: voice.type === "custom" ? voice.voiceName : voice.gender,
      });

      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setStoryIdea("");
      setInspiration("none");
      setTone("casual");
      setGenre("documentary");
      setDisableVoiceExpressions(false);
      setBrandName("");
      setCharacterConsistencyEnabled(false);
      setFormat("portrait");
      setLength("brief");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setVoice({ type: "standard", gender: "female" });
      setCharacterDescription("");
      setCharacterDescOpen(false);
      setBrandMarkEnabled(false);
      setBrandMarkText("");
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setStoryIdea(project.content ?? "");

      const nextFormat = (project.format as VideoFormat) ?? "portrait";
      setFormat(["landscape", "portrait", "square"].includes(nextFormat) ? nextFormat : "portrait");

      // Map project length to story length
      const projectLength = project.length as string;
      if (projectLength === "presentation") {
        setLength("extended");
      } else if (projectLength === "short") {
        setLength("short");
      } else {
        setLength("brief");
      }

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
        <span className="text-xs sm:text-sm font-medium text-primary">Creating story...</span>
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
                  <div className="text-center">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-3">
                      <Clapperboard className="h-3.5 w-3.5" />
                      Visual Story
                    </div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                      Create Your Story
                    </h1>
                    <p className="mt-1.5 sm:mt-2 text-sm text-muted-foreground/70">
                      Turn your ideas into compelling visual narratives
                    </p>
                  </div>

                  {/* Story Idea Input */}
                  <StoryIdeaInput value={storyIdea} onChange={setStoryIdea} />

                  {/* Story Settings */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm">
                    <InspirationSelector selected={inspiration} onSelect={setInspiration} />
                    <div className="h-px bg-border/30" />
                    <ToneSelector selected={tone} onSelect={setTone} />
                    <div className="h-px bg-border/30" />
                    <GenreSelector selected={genre} onSelect={setGenre} />
                  </div>

                  {/* Voice Settings */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm">
                    <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
                      <div className="flex-1">
                        <VoiceSelector selected={voice} onSelect={setVoice} />
                      </div>
                      <div className="flex-1">
                        <InclinationSelector 
                          disabled={disableVoiceExpressions}
                          onDisabledChange={setDisableVoiceExpressions}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Character Consistency - Pro Feature */}
                  <CharacterConsistencyToggle 
                    enabled={characterConsistencyEnabled}
                    onToggle={setCharacterConsistencyEnabled}
                  />

                  {/* Brand Name (Optional) */}
                  <div className="rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm">
                    <Label htmlFor="brand-name" className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      Brand / Character Name (Optional)
                    </Label>
                    <Input
                      id="brand-name"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      placeholder="e.g., TechCorp, Alex the Explorer"
                      className="mt-3"
                    />
                    <p className="text-xs text-muted-foreground/60 mt-2">
                      Include a specific brand or character name to weave into the story
                    </p>
                  </div>

                  {/* Character Description - Collapsible */}
                  <Collapsible open={characterDescOpen} onOpenChange={setCharacterDescOpen}>
                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-4 backdrop-blur-sm shadow-sm hover:bg-muted/30 transition-colors">
                      <span className="text-xs sm:text-sm font-medium flex items-center gap-2">
                        <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        Character Appearance
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 sm:h-4 sm:w-4 transition-transform duration-200 ${characterDescOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="rounded-b-xl sm:rounded-b-2xl border border-t-0 border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm -mt-2">
                        <CharacterDescriptionInput value={characterDescription} onChange={setCharacterDescription} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Technical Configuration */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-6 backdrop-blur-sm shadow-sm overflow-hidden">
                    <FormatSelector selected={format} onSelect={setFormat} disabledFormats={disabledFormats} />
                    <div className="h-px bg-border/30" />
                    <StorytellingLengthSelector selected={length} onSelect={setLength} />
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
                      Create Story
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
                    <h2 className="text-xl font-semibold text-foreground mb-2">Story Generation Failed</h2>
                    <p className="text-muted-foreground mb-6">{getUserFriendlyErrorMessage(generationState.error)}</p>
                    <Button onClick={() => { reset(); handleGenerate(); }} variant="outline" className="gap-2">
                      <RotateCcw className="h-4 w-4" />
                      Try Again
                    </Button>
                    {isAdmin && <AdminLogsPanel logs={adminLogs} show={showAdminLogs} onToggle={() => setShowAdminLogs(!showAdminLogs)} />}
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
                    title={generationState.title || "Untitled Story"}
                    scenes={generationState.scenes}
                    format={generationState.format || format}
                    onNewProject={handleNewProject}
                    onRegenerateAll={() => {
                      reset();
                      handleGenerate();
                    }}
                    totalTimeMs={generationState.totalTimeMs}
                    costTracking={generationState.costTracking}
                    generationId={generationState.generationId}
                    projectId={generationState.projectId}
                    brandMark={brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined}
                  />
                  {isAdmin && <AdminLogsPanel logs={adminLogs} show={showAdminLogs} onToggle={() => setShowAdminLogs(!showAdminLogs)} />}
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

        {/* Modals */}
        <UpgradeRequiredModal
          open={showUpgradeModal}
          onOpenChange={setShowUpgradeModal}
          reason={upgradeReason}
          showCreditsOption={plan !== "free"}
        />

        <SubscriptionSuspendedModal
          open={showSuspendedModal}
          onOpenChange={setShowSuspendedModal}
          status={suspendedStatus}
        />
      </WorkspaceLayout>
    );
  }
);
