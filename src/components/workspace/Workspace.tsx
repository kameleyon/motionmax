import { useState, forwardRef, useImperativeHandle, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, Menu, AlertCircle, RotateCcw, ChevronDown, Lightbulb, Users, MessageSquareOff, ChevronRight, ChevronLeft } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContentInput } from "./ContentInput";
import { FormatSelector, type VideoFormat } from "./FormatSelector";
import { LengthSelector, type VideoLength } from "./LengthSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import { VoiceSelector, type VoiceSelection } from "./VoiceSelector";
import { PresenterFocusInput } from "./PresenterFocusInput";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { GenerationProgress } from "./GenerationProgress";
import { GenerationResult } from "./GenerationResult";
import { CreditEstimate } from "./CreditEstimate";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { ThemedLogo } from "@/components/ThemedLogo";
import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess, getCreditsRequired, PLAN_LIMITS } from "@/hooks/useSubscription";
import { useToast } from "@/hooks/use-toast";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { cn } from "@/lib/utils";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";

export interface WorkspaceHandle {
  resetWorkspace: () => void;
  openProject: (projectId: string) => Promise<void>;
}

type WizardStep = 1 | 2 | 3;

const STEP_LABELS = ["Content", "Art Direction", "Voice & Polish"] as const;

export const Workspace = forwardRef<WorkspaceHandle>(function Workspace(_, ref) {
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<VideoFormat>("portrait");
  const [length, setLength] = useState<VideoLength>("brief");
  const [style, setStyle] = useState<VisualStyle>("minimalist");
  const [customStyle, setCustomStyle] = useState("");
  const [voice, setVoice] = useState<VoiceSelection>({ type: "standard", gender: "female" });
  const [presenterFocus, setPresenterFocus] = useState("");
  const [characterDescription, setCharacterDescription] = useState("");
  const [presenterFocusOpen, setPresenterFocusOpen] = useState(false);
  const [characterDescOpen, setCharacterDescOpen] = useState(false);
  const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
  const [brandMarkText, setBrandMarkText] = useState("");
  const [disableExpressions, setDisableExpressions] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);

  // Subscription and plan validation
  const { plan, creditsBalance, subscriptionStatus, checkSubscription } = useSubscription();
  const { toast } = useToast();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState("");
  const [showSuspendedModal, setShowSuspendedModal] = useState(false);
  const [suspendedStatus, setSuspendedStatus] = useState<"past_due" | "unpaid" | "canceled">("past_due");

  const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();
  const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId, generationState.step);

  const canGenerate = content.trim().length > 0 && !generationState.isGenerating;

  // Get disabled formats based on plan (free users can only use landscape)
  const limits = PLAN_LIMITS[plan];
  const disabledFormats: VideoFormat[] = (["landscape", "portrait", "square"] as VideoFormat[]).filter(
    f => !limits.allowedFormats.includes(f)
  );

  // Auto-recovery: if we're in a "generating" state but the generation actually completed
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

        if (data?.status === "complete" && generationState.step !== "complete") {
          console.log("[Workspace] Found completed generation in DB, reloading project");
          await loadProject(generationState.projectId!);
        }
      };

      checkGenerationStatus();
      const intervalId = setInterval(checkGenerationStatus, 5000);
      return () => clearInterval(intervalId);
    }
  }, [generationState.projectId, generationState.isGenerating, generationState.step, loadProject]);

  const handleGenerate = async () => {
    if (!canGenerate) return;

    if (subscriptionStatus === "past_due" || subscriptionStatus === "unpaid") {
      setSuspendedStatus(subscriptionStatus as "past_due" | "unpaid");
      setShowSuspendedModal(true);
      return;
    }

    const creditsRequired = getCreditsRequired("doc2video", length);
    
    const validation = validateGenerationAccess(
      plan,
      creditsBalance,
      "doc2video",
      length,
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
      content,
      format,
      length,
      style,
      customStyle: style === "custom" ? customStyle : undefined,
      brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
      presenterFocus: presenterFocus.trim() ? presenterFocus.trim().slice(0, 2000) : undefined,
      characterDescription: characterDescription.trim() || undefined,
      disableExpressions,
    });

    setTimeout(() => checkSubscription(), 2000);
  };

  const handleNewProject = () => {
    reset();
    setContent("");
    setFormat("portrait");
    setLength("brief");
    setStyle("minimalist");
    setCustomStyle("");
    setVoice({ type: "standard", gender: "female" });
    setPresenterFocus("");
    setCharacterDescription("");
    setPresenterFocusOpen(false);
    setCharacterDescOpen(false);
    setBrandMarkEnabled(false);
    setBrandMarkText("");
    setDisableExpressions(false);
    setWizardStep(1);
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

    setWizardStep(1);
  };

  useImperativeHandle(ref, () => ({
    resetWorkspace: handleNewProject,
    openProject: handleOpenProject,
  }));

  const canProceedStep1 = content.trim().length > 0;

  return (
    <div className="flex h-screen flex-col bg-background overflow-hidden">
      {/* Top Bar */}
      <header className="flex h-14 sm:h-16 items-center justify-between border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 sm:gap-4">
          <SidebarTrigger className="lg:hidden">
            <Menu className="h-5 w-5 text-muted-foreground" />
          </SidebarTrigger>
          <div className="hidden lg:flex items-center gap-3">
            <ThemedLogo className="h-10 w-auto" />
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {generationState.step !== "idle" && generationState.step !== "complete" && generationState.step !== "error" && (
            <motion.div
              className="flex items-center gap-2 rounded-full bg-primary/10 px-3 sm:px-4 py-1.5"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span className="text-xs sm:text-sm font-medium text-primary">Generating...</span>
            </motion.div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4 sm:py-12">
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
                  <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                    What would you like to create?
                  </h1>
                  <p className="mt-1.5 sm:mt-2 text-sm text-muted-foreground/70">
                    Paste your content or describe your video idea
                  </p>
                </div>

                {/* Step Indicator */}
                <div className="flex items-center justify-center gap-2">
                  {STEP_LABELS.map((label, i) => {
                    const stepNum = (i + 1) as WizardStep;
                    const isActive = wizardStep === stepNum;
                    const isCompleted = wizardStep > stepNum;
                    return (
                      <button
                        key={label}
                        onClick={() => {
                          if (stepNum === 1 || canProceedStep1) setWizardStep(stepNum);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : isCompleted
                            ? "bg-muted/50 text-foreground cursor-pointer hover:bg-muted"
                            : "bg-transparent text-muted-foreground/50"
                        )}
                      >
                        <span className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : isCompleted
                            ? "bg-muted-foreground/30 text-foreground"
                            : "bg-muted-foreground/15 text-muted-foreground/50"
                        )}>
                          {stepNum}
                        </span>
                        <span className="hidden sm:inline">{label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Wizard Steps */}
                <AnimatePresence mode="wait">
                  {wizardStep === 1 && (
                    <motion.div
                      key="step1"
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className="space-y-4 sm:space-y-6"
                    >
                      <ContentInput content={content} onContentChange={setContent} />

                      {/* Collapsible Advanced Options */}
                      <div className="space-y-2 sm:space-y-3">
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
                      </div>

                      {/* Next Step */}
                      <Button
                        onClick={() => setWizardStep(2)}
                        disabled={!canProceedStep1}
                        className="w-full gap-2 rounded-full py-5 sm:py-6 text-sm sm:text-base font-medium"
                      >
                        Continue to Art Direction
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </motion.div>
                  )}

                  {wizardStep === 2 && (
                    <motion.div
                      key="step2"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className="space-y-4 sm:space-y-6"
                    >
                      <div className="rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-6 backdrop-blur-sm shadow-sm space-y-4 sm:space-y-6 overflow-hidden">
                        <FormatSelector selected={format} onSelect={setFormat} disabledFormats={disabledFormats} />
                        <div className="h-px bg-border/30" />
                        <LengthSelector selected={length} onSelect={setLength} />
                        <div className="h-px bg-border/30" />
                        <StyleSelector
                          selected={style}
                          customStyle={customStyle}
                          onSelect={setStyle}
                          onCustomStyleChange={setCustomStyle}
                          brandMarkEnabled={brandMarkEnabled}
                          brandMarkText={brandMarkText}
                          onBrandMarkEnabledChange={setBrandMarkEnabled}
                          onBrandMarkTextChange={setBrandMarkText}
                        />
                      </div>

                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          onClick={() => setWizardStep(1)}
                          className="flex-1 gap-2 rounded-full py-5 sm:py-6"
                        >
                          <ChevronLeft className="h-4 w-4" />
                          Back
                        </Button>
                        <Button
                          onClick={() => setWizardStep(3)}
                          className="flex-1 gap-2 rounded-full py-5 sm:py-6 text-sm sm:text-base font-medium"
                        >
                          Continue to Voice
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </motion.div>
                  )}

                  {wizardStep === 3 && (
                    <motion.div
                      key="step3"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className="space-y-4 sm:space-y-6"
                    >
                      <div className="rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-6 backdrop-blur-sm shadow-sm space-y-4 sm:space-y-6">
                        <VoiceSelector selected={voice} onSelect={setVoice} />
                        <div className="h-px bg-border/30" />
                        <div className="flex items-center gap-2 sm:gap-3">
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
                      </div>

                      {/* Credit Estimate */}
                      <CreditEstimate
                        projectType="doc2video"
                        length={length}
                        creditsBalance={creditsBalance}
                      />

                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          onClick={() => setWizardStep(2)}
                          className="rounded-full py-5 sm:py-6 px-6"
                        >
                          <ChevronLeft className="h-4 w-4" />
                          Back
                        </Button>
                        <motion.div className="flex-1" whileHover={{ scale: canGenerate ? 1.01 : 1 }} whileTap={{ scale: canGenerate ? 0.99 : 1 }}>
                          <Button
                            onClick={handleGenerate}
                            disabled={!canGenerate}
                            className="w-full gap-2 sm:gap-2.5 rounded-full py-5 sm:py-6 text-sm sm:text-base font-medium shadow-sm transition-all hover:shadow-md disabled:opacity-40"
                          >
                            <Play className="h-4 w-4" />
                            Generate Video
                          </Button>
                        </motion.div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
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
                  <Button onClick={() => { reset(); }} variant="outline" className="gap-2">
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
                  title={generationState.title || "Untitled Video"}
                  scenes={generationState.scenes}
                  format={generationState.format || format}
                  onNewProject={handleNewProject}
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
        </div>
      </main>

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
    </div>
  );
});
