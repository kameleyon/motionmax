import { useState, forwardRef, useImperativeHandle, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, Wallpaper } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormatSelector, type VideoFormat } from "./FormatSelector";
import { VoiceSelector, type VoiceSelection } from "./VoiceSelector";
import { GenerationProgress } from "./GenerationProgress";

import { SmartFlowStyleSelector, type SmartFlowStyle } from "./SmartFlowStyleSelector";
import { SmartFlowResult } from "./SmartFlowResult";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess } from "@/hooks/useSubscription";
import { useToast } from "@/hooks/use-toast";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";

export interface WorkspaceHandle {
  resetWorkspace: () => void;
  openProject: (projectId: string) => Promise<void>;
}

interface SmartFlowWorkspaceProps {
  projectId?: string | null;
}

const MAX_DATA_LENGTH = 500000; // 500k characters

export const SmartFlowWorkspace = forwardRef<WorkspaceHandle, SmartFlowWorkspaceProps>(
  function SmartFlowWorkspace({ projectId: initialProjectId }, ref) {
    const [dataContent, setDataContent] = useState("");
    const [extractionPrompt, setExtractionPrompt] = useState("");
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [style, setStyle] = useState<SmartFlowStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [enableVoice, setEnableVoice] = useState(false);
    const [voice, setVoice] = useState<VoiceSelection>({ type: "standard", gender: "female" });
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

    const canGenerate = dataContent.trim().length > 0 && extractionPrompt.trim().length > 0 && !generationState.isGenerating;

    // Load project if projectId provided (and check for completed generations)
    useEffect(() => {
      if (initialProjectId) {
        // Always load the project - loadProject checks the database for completed generations
        // and will restore the complete state if the generation finished while user was away
        handleOpenProject(initialProjectId);
      }
    }, [initialProjectId]);

    // Additional check: if we're in a "generating" state but the generation actually completed
    // (e.g., after page reload), poll the database once to verify
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
            console.log("[SmartFlowWorkspace] Found completed generation in DB, reloading project");
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

      // Validate plan access - infographics require Starter+
      const validation = validateGenerationAccess(
        plan,
        creditsBalance,
        "smartflow",
        "short",
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
        content: dataContent,
        presenterFocus: extractionPrompt, // Reusing presenterFocus for extraction prompt
        format,
        style,
        customStyle: style === "custom" ? customStyle : undefined,
        customStyleImage: style === "custom" ? customStyleImage : undefined,
        length: "short", // Fixed for Smart Flow - single scene
        brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
        projectType: "smartflow", // Smart Flow uses dedicated single-scene backend
        // Voice selection (only if enabled)
        voiceType: enableVoice ? voice.type : undefined,
        voiceId: enableVoice ? voice.voiceId : undefined,
        // For standard voices, pass gender as voiceName (e.g., "male" or "female")
        // For custom voices, pass the actual voice name
        voiceName: enableVoice 
          ? (voice.type === "custom" ? voice.voiceName : voice.gender) 
          : undefined,
      });

      // Refresh subscription state after starting generation
      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setDataContent("");
      setExtractionPrompt("");
      setFormat("portrait");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setEnableVoice(false);
      setVoice({ type: "standard", gender: "female" });
      setBrandMarkEnabled(false);
      setBrandMarkText("");
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setDataContent(project.content ?? "");
      // Note: extraction prompt is stored in content or could be extracted from project metadata

      const nextFormat = (project.format as VideoFormat) ?? "portrait";
      setFormat(["landscape", "portrait", "square"].includes(nextFormat) ? nextFormat : "portrait");

      const savedStyle = (project.style ?? "minimalist") as SmartFlowStyle;
      const validStyles: SmartFlowStyle[] = ["minimalist", "doodle", "stick", "realistic", "storybook", "caricature", "sketch", "crayon", "chalkboard"];
      setStyle(validStyles.includes(savedStyle) ? savedStyle : "minimalist");
      
      // Restore voice setting - if voice_type is set and not undefined, voice was enabled
      const hasVoice = !!project.voice_type && project.voice_type !== "none";
      setEnableVoice(hasVoice);
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
                      <Wallpaper className="h-3.5 w-3.5" />
                      Smart Flow
                    </span>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                      Create Your Infographic
                    </h1>
                    <p className="text-sm text-muted-foreground/70">
                      Turn data into visual insights
                    </p>
                  </div>

                  {/* Data Input */}
                  <div className="space-y-2">
                    <Label htmlFor="data-input" className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      Your Data Source
                    </Label>
                    <Textarea
                      id="data-input"
                      placeholder="Paste your data, article, or source text here..."
                      value={dataContent}
                      onChange={(e) => setDataContent(e.target.value.slice(0, MAX_DATA_LENGTH))}
                      className="min-h-[180px] rounded-xl sm:rounded-2xl border-border/50 bg-muted/50 dark:bg-white/10 p-4 sm:p-6 text-sm resize-none focus:bg-background transition-colors"
                    />
                    <div className="flex justify-end">
                      <span className={`text-xs ${dataContent.length > MAX_DATA_LENGTH * 0.9 ? 'text-destructive' : 'text-muted-foreground/50'}`}>
                        {dataContent.length.toLocaleString()} / {MAX_DATA_LENGTH.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Extraction Prompt */}
                  <div className="space-y-2">
                    <Label htmlFor="extraction-prompt" className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                      What key insight should we extract?
                    </Label>
                    <Input
                      id="extraction-prompt"
                      placeholder="e.g., The top 3 combinations for business success..."
                      value={extractionPrompt}
                      onChange={(e) => setExtractionPrompt(e.target.value)}
                      className="rounded-xl border-border/50 bg-muted/50 dark:bg-white/10 focus:bg-background transition-colors"
                    />
                  </div>

                  {/* Configuration */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl sm:rounded-2xl border border-border/50 bg-card/50 p-3 sm:p-6 backdrop-blur-sm shadow-sm overflow-hidden">
                    {/* Style Selector */}
                    <SmartFlowStyleSelector
                      selected={style}
                      onSelect={setStyle}
                      customStyle={customStyle}
                      onCustomStyleChange={setCustomStyle}
                      customStyleImage={customStyleImage}
                      onCustomStyleImageChange={setCustomStyleImage}
                      brandMarkEnabled={brandMarkEnabled}
                      brandMarkText={brandMarkText}
                      onBrandMarkEnabledChange={setBrandMarkEnabled}
                      onBrandMarkTextChange={setBrandMarkText}
                    />
                    
                    <div className="h-px bg-border/30" />
                    
                    {/* Format Selector */}
                    <FormatSelector selected={format} onSelect={setFormat} />
                    
                    <div className="h-px bg-border/30" />
                    
                    {/* Voice Toggle */}
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                            Enable Voice
                          </h3>
                          <p className="text-xs text-muted-foreground/50">
                            Generate audio narration (creates a mini video)
                          </p>
                        </div>
                        <Switch
                          checked={enableVoice}
                          onCheckedChange={setEnableVoice}
                        />
                      </div>
                      
                      {enableVoice && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="pt-2"
                        >
                          <VoiceSelector selected={voice} onSelect={setVoice} />
                        </motion.div>
                      )}
                    </div>
                  </div>

                  {/* Generate Button */}
                  <motion.div whileHover={{ scale: canGenerate ? 1.01 : 1 }} whileTap={{ scale: canGenerate ? 0.99 : 1 }}>
                    <Button
                      onClick={handleGenerate}
                      disabled={!canGenerate}
                      className="w-full gap-2 sm:gap-2.5 rounded-full bg-primary py-5 sm:py-6 text-sm sm:text-base font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md disabled:opacity-40"
                    >
                      <Play className="h-4 w-4" />
                      Generate Infographic
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
                  <SmartFlowResult
                    title={generationState.title || "Untitled Infographic"}
                    scenes={generationState.scenes}
                    format={generationState.format || format}
                    enableVoice={enableVoice}
                    onNewProject={handleNewProject}
                    totalTimeMs={generationState.totalTimeMs}
                    costTracking={generationState.costTracking}
                    generationId={generationState.generationId}
                    projectId={generationState.projectId}
                    onScenesUpdate={(updatedScenes) => {
                      // Update local state if needed for regeneration
                    }}
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
