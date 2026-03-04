import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Film, Loader2, Lightbulb, MessageSquareOff, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
import { CinematicResult } from "./CinematicResult";

import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess } from "@/hooks/useSubscription";
import { useToast } from "@/hooks/use-toast";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";
import { useGenerationLogs } from "@/hooks/useGenerationLogs";
import { GenerationLogsPanel } from "./GenerationLogsPanel";
import type { WorkspaceHandle } from "./Doc2VideoWorkspace";

interface CinematicWorkspaceProps {
  projectId?: string | null;
}

export const CinematicWorkspace = forwardRef<WorkspaceHandle, CinematicWorkspaceProps>(
  function CinematicWorkspace({ projectId: initialProjectId }, ref) {
    // Content input (like Doc2Video)
    const [content, setContent] = useState("");
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [length, setLength] = useState<VideoLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("realistic");
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

    // Use shared pipeline instead of manual state management
    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();

    // Subscription and plan validation  
    const { plan, creditsBalance, subscriptionStatus, checkSubscription } = useSubscription();
    const { toast } = useToast();
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);
    const [upgradeReason, setUpgradeReason] = useState("");
    const [showSuspendedModal, setShowSuspendedModal] = useState(false);
    const [suspendedStatus, setSuspendedStatus] = useState<"past_due" | "unpaid" | "canceled">("past_due");
    const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId, generationState.step);
    const { logs: generationLogs, showLogs, setShowLogs } = useGenerationLogs(generationState.generationId, generationState.projectId, generationState.isGenerating);
    const [isResuming, setIsResuming] = useState(false);

    const handleResume = async () => {
      if (!generationState.projectId) return;
      setIsResuming(true);
      try {
        await loadProject(generationState.projectId);
      } finally {
        setIsResuming(false);
      }
    };

    const canGenerate = content.trim().length > 0 && !generationState.isGenerating;

    // All formats (landscape, portrait, square) are available for short
    const disabledFormats: VideoFormat[] = [];

    // DB polling: detect if generation completed while app was backgrounded (mobile resilience)
    // IMPORTANT: Only triggers loadProject when the generation is NOT already being actively
    // processed on the client side. Without this guard, loadProject would see missing videos,
    // start a new resumeCinematic loop, and the effect would keep spawning duplicates every 5s.
    const isResumeInFlightRef = useRef(false);
    useEffect(() => {
      if (
        generationState.projectId && 
        generationState.isGenerating && 
        generationState.step !== "complete" && 
        generationState.step !== "error"
      ) {
        const checkGenerationStatus = async () => {
          // Don't re-trigger if a resume is already in flight
          if (isResumeInFlightRef.current) return;

          const { data } = await supabase
            .from("generations")
            .select("id,status,progress,scenes,error_message")
            .eq("project_id", generationState.projectId!)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          // Only reload if backend says complete AND we haven't reached complete on client
          // AND the generation truly has all videos (otherwise the current resume handles it)
          if (data?.status === "complete" && generationState.step !== "complete") {
            const scenes = Array.isArray(data.scenes) ? data.scenes : [];
            const allVideos = scenes.every((s: any) => !!s?.videoUrl);
            if (allVideos) {
              console.log("[CinematicWorkspace] All videos done in DB, reloading project");
              isResumeInFlightRef.current = true;
              await loadProject(generationState.projectId!);
              isResumeInFlightRef.current = false;
            }
          }
        };

        checkGenerationStatus();
        const intervalId = setInterval(checkGenerationStatus, 10000);
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

      const validation = validateGenerationAccess(
        plan,
        creditsBalance,
        "cinematic",
        length,
        format,
        brandMarkEnabled && brandMarkText.trim().length > 0,
        style === "custom",
        subscriptionStatus || undefined,
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
        voiceType: voice.type,
        voiceId: voice.voiceId,
        voiceName: voice.type === "custom" ? voice.voiceName : voice.gender,
        projectType: "cinematic",
      });

      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setContent("");
      setFormat("portrait");
      setLength("brief");
      setStyle("realistic");
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

      const savedStyle = (project.style ?? "realistic") as VisualStyle;
      setStyle(savedStyle);

      if (project.character_description) setCharacterDescription(project.character_description);
      if (project.presenter_focus) setPresenterFocus(project.presenter_focus);
      if (project.voice_type) {
        setVoice({
          type: project.voice_type as "standard" | "custom",
          voiceId: project.voice_id ?? undefined,
          voiceName: project.voice_name ?? undefined,
          gender: project.voice_name as "male" | "female" | undefined,
        });
      }
      if (project.brand_mark) {
        setBrandMarkEnabled(true);
        setBrandMarkText(project.brand_mark);
      }
      if (project.character_consistency_enabled) {
        setCharacterConsistencyEnabled(true);
      }
    };

    // Load project from URL if provided
    useEffect(() => {
      if (initialProjectId) {
        void handleOpenProject(initialProjectId);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialProjectId]);

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
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="text-xs sm:text-sm font-medium text-primary">Creating cinematic...</span>
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
                      <Film className="h-3.5 w-3.5" />
                      Cinematic - Beta
                    </div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                      Create Cinematic Video
                    </h1>
                    <p className="mt-1.5 sm:mt-2 text-sm text-muted-foreground/70">
                      Transform your ideas into cinematic AI-generated videos using Replicate + Grok
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
                      Create Cinematic Video
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
                   <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-8 text-center">
                     <AlertCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
                     <h2 className="text-xl font-semibold text-foreground mb-2">Cinematic Generation Failed</h2>
                     <p className="text-muted-foreground mb-6">{getUserFriendlyErrorMessage(generationState.error)}</p>
                     <div className="flex flex-wrap items-center justify-center gap-3">
                       {generationState.projectId && (
                         <Button onClick={handleResume} disabled={isResuming} className="gap-2">
                           {isResuming ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                           Continue Generation
                         </Button>
                       )}
                       <Button onClick={() => { handleNewProject(); }} variant="outline" className="gap-2">
                         <RotateCcw className="h-4 w-4" />
                         Start Over
                       </Button>
                     </div>
                   </div>

                   {isAdmin && <AdminLogsPanel logs={adminLogs} show={showAdminLogs} onToggle={() => setShowAdminLogs(!showAdminLogs)} />}
                </motion.div>
              ) : generationState.step === "complete" && generationState.scenes && generationState.scenes.length > 0 ? (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="max-w-5xl mx-auto"
                >
                  <CinematicResult
                    title={generationState.title || "Untitled Cinematic"}
                    scenes={generationState.scenes as any}
                    projectId={generationState.projectId}
                    generationId={generationState.generationId}
                    finalVideoUrl={generationState.finalVideoUrl}
                    onNewProject={handleNewProject}
                    format={format}
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
                  {/* Progress UI */}
                  <div className="rounded-2xl border border-border/50 bg-card/50 p-8 text-center">
                    <Loader2 className="h-12 w-12 mx-auto text-primary mb-4 animate-spin" />
                    <h2 className="text-xl font-semibold text-foreground mb-2">
                      {generationState.step === "scripting" && "Writing Script..."}
                      {generationState.step === "visuals" && "Creating Scenes..."}
                      {generationState.step === "rendering" && "Finalizing Video..."}
                      {generationState.step === "analysis" && "Preparing..."}
                    </h2>
                    <p className="text-muted-foreground mb-4">
                      {generationState.statusMessage || "Please wait while we create your cinematic video..."}
                    </p>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div 
                        className="bg-primary h-2 rounded-full transition-all duration-500" 
                        style={{ width: `${generationState.progress}%` }}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">{generationState.progress}% complete</p>

                    {/* Continue Generation button - always visible during generation */}
                    {generationState.projectId && (
                      <div className="mt-6">
                        <Button
                          onClick={handleResume}
                          disabled={isResuming}
                          variant="outline"
                          size="sm"
                          className="gap-2"
                        >
                          {isResuming ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          Continue Generation
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Generation Logs - visible to everyone */}
                  <GenerationLogsPanel
                    logs={generationLogs}
                    show={showLogs}
                    onToggle={() => setShowLogs(!showLogs)}
                    isGenerating={generationState.isGenerating}
                  />
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
