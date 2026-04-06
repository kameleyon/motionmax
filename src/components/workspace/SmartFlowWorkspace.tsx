import { createScopedLogger } from "@/lib/logger";
import { useState, forwardRef, useImperativeHandle, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, Wallpaper } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { CinematicSourceInput, type SourceAttachment } from "./CinematicSourceInput";
import { processAttachments } from "@/lib/attachmentProcessor";
import type { VideoFormat } from "./FormatSelector";
import type { SpeakerVoice } from "./SpeakerSelector";
import type { Language } from "./LanguageSelector";
import type { CaptionStyle } from "./CaptionStyleSelector";
import { WorkspaceConfigGrid } from "./WorkspaceConfigGrid";
import { CreditCostDisplay } from "./CreditCostDisplay";
import { VideoPlayer } from "./VideoPlayer";

import { SmartFlowStyleSelector, type SmartFlowStyle } from "./SmartFlowStyleSelector";
import { SmartFlowResult } from "./SmartFlowResult";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess } from "@/hooks/useSubscription";
import { toast } from "sonner";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";
import { useWorkspaceDraft } from "@/hooks/useWorkspaceDraft";
import { useInfographicsUsage } from "@/hooks/useInfographicsUsage";
import { PLAN_LIMITS } from "@/lib/planLimits";

export interface WorkspaceHandle {
  resetWorkspace: () => void;
  openProject: (projectId: string) => Promise<void>;
}

interface SmartFlowWorkspaceProps {
  projectId?: string | null;
}

const log = createScopedLogger("SmartFlowWorkspace");

export const SmartFlowWorkspace = forwardRef<WorkspaceHandle, SmartFlowWorkspaceProps>(
  function SmartFlowWorkspace({ projectId: initialProjectId }, ref) {
    const [content, setContent] = useState("");
    const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [style, setStyle] = useState<SmartFlowStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [speaker, setSpeaker] = useState<SpeakerVoice>("Nova");
    const [language, setLanguage] = useState<Language>("en");
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");
    const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("none");

    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();
    const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId, generationState.step);

    // Subscription and plan validation
    const { plan, creditsBalance, subscriptionStatus, subscriptionEnd, checkSubscription } = useSubscription();
    const { count: infographicsUsed } = useInfographicsUsage();
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);
    const [upgradeReason, setUpgradeReason] = useState("");
    const [showSuspendedModal, setShowSuspendedModal] = useState(false);
    const [suspendedStatus, setSuspendedStatus] = useState<"past_due" | "unpaid" | "canceled">("past_due");

    // Auto-save draft to localStorage
    const { loadDraft } = useWorkspaceDraft(
      "smartflow",
      { content, format, style },
      generationState.step === "idle"
    );

    // Restore draft on mount if no project loaded
    useEffect(() => {
      if (initialProjectId) return;
      const draft = loadDraft();
      if (draft?.content) setContent(draft.content as string);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const canGenerate = content.trim().length >= 10 && !generationState.isGenerating;

    // Load project if projectId provided, or reset if project param removed (tab click)
    useEffect(() => {
      if (initialProjectId) {
        handleOpenProject(initialProjectId);
      } else {
        handleNewProject();
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
            log.debug("Found completed generation in DB, reloading project");
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

      // Check monthly infographics limit
      const monthlyLimit = PLAN_LIMITS[plan].infographicsPerMonth;
      if (monthlyLimit !== 999999 && infographicsUsed >= monthlyLimit) {
        const limitMessage = plan === "free"
          ? "You've reached the Free plan limit. Upgrade to Starter or higher to create infographics."
          : `You've reached your monthly limit of ${monthlyLimit} infographics. Upgrade to get more or wait until next month.`;
        toast.error("Monthly Limit Reached", { description: limitMessage });
        setUpgradeReason(limitMessage);
        setShowUpgradeModal(true);
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
        subscriptionStatus || undefined,
        subscriptionEnd,
      );

      if (!validation.canGenerate) {
        toast.error("Cannot Generate", { description: validation.error });
        setUpgradeReason(validation.error || "Please upgrade your plan to continue.");
        setShowUpgradeModal(true);
        return;
      }

      const attachmentContent = await processAttachments(sourceAttachments);
      const enrichedContent = content + attachmentContent;

      startGeneration({
        content: enrichedContent,
        format,
        style,
        customStyle: style === "custom" ? customStyle : undefined,
        customStyleImage: style === "custom" ? customStyleImage : undefined,
        length: "short", // Fixed for Smart Flow - single scene
        brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
        language,
        projectType: "smartflow", // Smart Flow uses dedicated single-scene backend
        voiceType: "standard",
        voiceName: speaker,
        captionStyle,
      });

      // Refresh subscription state after starting generation
      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setContent("");
      setSourceAttachments([]);
      setFormat("portrait");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setSpeaker("Nova");
      setLanguage("en");
      setBrandMarkEnabled(false);
      setBrandMarkText("");
      setCaptionStyle("none");
    };

    const handleRegenerate = () => {
      reset();
      setTimeout(() => handleGenerate(), 100);
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setContent(project.content ?? "");
      // Note: extraction prompt is stored in content or could be extracted from project metadata

      const nextFormat = (project.format as VideoFormat) ?? "portrait";
      setFormat(["landscape", "portrait", "square"].includes(nextFormat) ? nextFormat : "portrait");

      const savedStyle = (project.style ?? "minimalist") as SmartFlowStyle;
      const validStyles: SmartFlowStyle[] = ["minimalist", "doodle", "stick", "realistic", "storybook", "caricature", "sketch", "crayon", "chalkboard"];
      setStyle(validStyles.includes(savedStyle) ? savedStyle : "minimalist");
      
      // Restore voice settings
      if (project.voice_name) {
        setSpeaker(project.voice_name as SpeakerVoice);
      }

      // Restore language from voice_inclination
      const savedLang = project.voice_inclination as Language | null;
      if (savedLang === "en" || savedLang === "fr" || savedLang === "ht") setLanguage(savedLang);
      else setLanguage("en");
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
      <WorkspaceLayout headerActions={headerActions} mode="smartflow" projectTitle={generationState.title}>
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

                  {/* Sources & Direction */}
                  <CinematicSourceInput
                    content={content}
                    onContentChange={setContent}
                    attachments={sourceAttachments}
                    onAttachmentsChange={setSourceAttachments}
                  />

                  {/* Compact Configuration Grid */}
                  <WorkspaceConfigGrid
                    format={format}
                    onFormatChange={setFormat}
                    duration="short"
                    onDurationChange={() => {}}
                    durationOptions={[{ id: "short", label: "\u22643 min" }]}
                    language={language}
                    onLanguageChange={setLanguage}
                    speaker={speaker}
                    onSpeakerChange={setSpeaker}
                    captionStyle={captionStyle}
                    onCaptionStyleChange={setCaptionStyle}
                    brandMarkText={brandMarkText}
                    onBrandMarkTextChange={(text) => { setBrandMarkText(text); setBrandMarkEnabled(text.trim().length > 0); }}
                  />

                  {/* Visual Style */}
                  <SmartFlowStyleSelector
                    selected={style}
                    onSelect={setStyle}
                    customStyle={customStyle}
                    onCustomStyleChange={setCustomStyle}
                    customStyleImage={customStyleImage}
                    onCustomStyleImageChange={setCustomStyleImage}
                  />

                  {/* Credit Cost Display */}
                  <CreditCostDisplay
                    projectType="smartflow"
                    length="smartflow"
                    creditsBalance={creditsBalance}
                  />

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
                    enableVoice={true}
                    onNewProject={handleNewProject}
                    onRegenerate={handleRegenerate}
                    totalTimeMs={generationState.totalTimeMs}
                    costTracking={generationState.costTracking}
                    generationId={generationState.generationId}
                    projectId={generationState.projectId}
                    onScenesUpdate={(updatedScenes) => {
                      // Update local state if needed for regeneration
                    }}
                    brandMark={brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined}
                    captionStyle={captionStyle}
                  />
                  {isAdmin && <AdminLogsPanel logs={adminLogs} show={showAdminLogs} onToggle={() => setShowAdminLogs(!showAdminLogs)} />}
                </motion.div>
              ) : (
                <motion.div
                  key="progress"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="w-full max-w-4xl mx-auto space-y-6"
                >
                  <VideoPlayer
                    exportState={{ status: "idle", progress: 0 }}
                    title={generationState.title || "Untitled Infographic"}
                    onDownload={() => {}}
                    format={generationState.format || format}
                    generationState={generationState}
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
