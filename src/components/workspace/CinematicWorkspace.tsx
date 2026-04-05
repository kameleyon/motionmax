import { createScopedLogger } from "@/lib/logger";
import { useState, useRef, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Film, Loader2, MessageSquareOff, RefreshCw, Monitor, Smartphone } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CinematicSourceInput, type SourceAttachment } from "./CinematicSourceInput";
import { processAttachments } from "@/lib/attachmentProcessor";
import type { VideoFormat } from "./FormatSelector";
import type { VideoLength } from "./LengthSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import { SpeakerSelector, type SpeakerVoice, getDefaultSpeaker } from "./SpeakerSelector";
import { LanguageSelector, type Language } from "./LanguageSelector";
import { CaptionStyleSelector, type CaptionStyle } from "./CaptionStyleSelector";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { CharacterConsistencyToggle } from "./CharacterConsistencyToggle";
import { CinematicResult } from "./CinematicResult";
import { VideoPlayer } from "./VideoPlayer";
import { CreditCostDisplay } from "./CreditCostDisplay";

import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess, PLAN_LIMITS } from "@/hooks/useSubscription";
import { toast } from "sonner";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";
import { useGenerationLogs } from "@/hooks/useGenerationLogs";
import { GenerationLogsPanel } from "./GenerationLogsPanel";
import { useWorkspaceDraft } from "@/hooks/useWorkspaceDraft";
import type { WorkspaceHandle } from "./Doc2VideoWorkspace";

const log = createScopedLogger("CinematicWorkspace");

interface CinematicWorkspaceProps {
  projectId?: string | null;
}

export const CinematicWorkspace = forwardRef<WorkspaceHandle, CinematicWorkspaceProps>(
  function CinematicWorkspace({ projectId: initialProjectId }, ref) {
    // Content input (like Doc2Video)
    const [content, setContent] = useState("");
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [length, setLength] = useState<VideoLength>("short");
    const [style, setStyle] = useState<VisualStyle>("realistic");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [speaker, setSpeaker] = useState<SpeakerVoice>("Nova");
    const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("none");
    const [language, setLanguage] = useState<Language>("en");
    const [characterDescription, setCharacterDescription] = useState("");
    const [characterDescOpen, setCharacterDescOpen] = useState(false);
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");
    const [disableExpressions, setDisableExpressions] = useState(false);
    const [characterConsistencyEnabled, setCharacterConsistencyEnabled] = useState(false);
    const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);

    // Use shared pipeline instead of manual state management
    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();

    // Subscription and plan validation  
    const { plan, creditsBalance, subscriptionStatus, subscriptionEnd, checkSubscription } = useSubscription();
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

    // Auto-save draft to localStorage
    const { loadDraft } = useWorkspaceDraft(
      "cinematic",
      { content, format, length, style, characterDescription },
      generationState.step === "idle"
    );

    // Restore draft on mount if no project loaded
    useEffect(() => {
      if (initialProjectId) return;
      const draft = loadDraft();
      if (draft?.content) setContent(draft.content as string);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const canGenerate = content.trim().length > 0 && !generationState.isGenerating;

    // Disable formats/lengths based on plan
    const limits = PLAN_LIMITS[plan];
    const disabledFormats: VideoFormat[] = (["landscape", "portrait", "square"] as VideoFormat[]).filter(
      f => !limits.allowedFormats.includes(f)
    );
    const disabledLengths: VideoLength[] = (["short", "brief", "presentation"] as VideoLength[]).filter(
      l => !limits.allowedLengths.includes(l)
    );

    // Auto-switch to allowed values if current selection becomes disabled
    useEffect(() => {
      // Only auto-switch when user is in form entry (idle) — skip when viewing a loaded project
      if (generationState.step !== "idle") return;
      if (disabledFormats.includes(format) && limits.allowedFormats.length > 0) {
        setFormat(limits.allowedFormats[0] as VideoFormat);
      }
    }, [plan, format, disabledFormats, limits.allowedFormats, generationState.step]);

    useEffect(() => {
      if (disabledLengths.includes(length) && limits.allowedLengths.length > 0) {
        setLength(limits.allowedLengths[0] as VideoLength);
      }
    }, [plan, length, disabledLengths, limits.allowedLengths]);

    // DB polling: detect if generation completed while app was backgrounded (mobile resilience)
    // IMPORTANT: Only triggers loadProject when the generation is NOT already being actively
    // processed on the client side. Without this guard, loadProject would see missing videos,
    // start a new resumeCinematic loop, and the effect would keep spawning duplicates every 5s.
    // DB polling: detect if generation completed while app was backgrounded.
    // Only runs when actively generating (not when viewing a completed project).
    const isResumeInFlightRef = useRef(false);
    const hasReloadedRef = useRef<string | null>(null);
    useEffect(() => {
      // Only poll when actively generating — NOT when viewing a complete/error project
      if (
        !generationState.projectId ||
        !generationState.isGenerating ||
        generationState.step === "complete" ||
        generationState.step === "error" ||
        generationState.step === "idle"
      ) {
        return;
      }

      // Don't poll if we already reloaded this project
      if (hasReloadedRef.current === generationState.projectId) return;

      const checkGenerationStatus = async () => {
        if (isResumeInFlightRef.current) return;

        const { data } = await supabase
          .from("generations")
          .select("id,status,progress,scenes,error_message")
          .eq("project_id", generationState.projectId!)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data?.status === "complete" && generationState.step !== "complete") {
          const scenes = Array.isArray(data.scenes) ? data.scenes : [];
          const allVideos = scenes.every((s: any) => !!s?.videoUrl);
          if (allVideos) {
            log.debug("All videos done in DB, reloading project");
            isResumeInFlightRef.current = true;
            hasReloadedRef.current = generationState.projectId!;
            await loadProject(generationState.projectId!);
            isResumeInFlightRef.current = false;
          }
        }
      };

      checkGenerationStatus();
      const intervalId = setInterval(checkGenerationStatus, 10000);
      return () => clearInterval(intervalId);
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
        subscriptionEnd,
      );

      if (!validation.canGenerate) {
        toast.error("Cannot Generate", { description: validation.error });
        setUpgradeReason(validation.error || "Please upgrade your plan to continue.");
        setShowUpgradeModal(true);
        return;
      }

      // Process attachments: upload images, read files, tag URLs for worker
      const attachmentContent = await processAttachments(sourceAttachments);
      const enrichedContent = content + attachmentContent;

      startGeneration({
        content: enrichedContent,
        format,
        length,
        style,
        customStyle: style === "custom" ? customStyle : undefined,
        customStyleImage: style === "custom" ? customStyleImage : undefined,
        brandMark: brandMarkEnabled && brandMarkText.trim() ? brandMarkText.trim() : undefined,
        characterDescription: characterDescription.trim() || undefined,
        disableExpressions: false,
        characterConsistencyEnabled: true,
        voiceType: "standard",
        voiceName: speaker,
        language,
        projectType: "cinematic",
      });

      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setContent("");
      setSourceAttachments([]);
      setFormat("portrait");
      setLength("short");
      setStyle("realistic");
      setCustomStyle("");
      setCustomStyleImage(null);
      setSpeaker("Nova");
      setCaptionStyle("none");
      setLanguage("en");
      setCharacterDescription("");
      setCharacterDescOpen(false);
      setBrandMarkEnabled(false);
      setBrandMarkText("");
      setDisableExpressions(false);
      setCharacterConsistencyEnabled(false);
    };

    // Regenerate: reset generation state but keep all user inputs, then re-trigger
    const handleRegenerate = () => {
      reset();
      // Small delay to let state clear, then trigger generation with existing inputs
      setTimeout(() => handleGenerate(), 100);
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
      if (project.voice_name) {
        setSpeaker(project.voice_name as SpeakerVoice);
      }
      if (project.brand_mark) {
        setBrandMarkEnabled(true);
        setBrandMarkText(project.brand_mark);
      }
      if (project.character_consistency_enabled) {
        setCharacterConsistencyEnabled(true);
      }

      // Restore language from voice_inclination
      const savedLang = project.voice_inclination as Language | null;
      if (savedLang === "en" || savedLang === "fr" || savedLang === "ht") setLanguage(savedLang);
      else setLanguage("en");
    };

    // Load project from URL if provided, or reset if project param removed (tab click)
    useEffect(() => {
      hasReloadedRef.current = null; // Reset reload guard on project switch
      if (initialProjectId) {
        void handleOpenProject(initialProjectId);
      } else {
        handleNewProject();
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
      <WorkspaceLayout headerActions={headerActions} mode="cinematic" projectTitle={generationState.title}>
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
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-muted/50 text-muted-foreground text-xs font-medium mb-3 border border-border/50">
                      <Film className="h-3.5 w-3.5 text-primary" />
                      Cinematic
                    </div>
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                      Create Cinematic Video
                    </h1>
                    <p className="mt-1.5 sm:mt-2 text-sm text-muted-foreground/70">
                      Transform your ideas into cinematic AI-generated videos using Replicate + Grok
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
                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    {/* Format: Landscape / Portrait */}
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Format</span>
                      <div className="flex gap-2">
                        {([
                          { id: "landscape" as const, icon: Monitor, label: "16:9" },
                          { id: "portrait" as const, icon: Smartphone, label: "9:16" },
                        ]).map(({ id, icon: Icon, label }) => {
                          const disabled = disabledFormats.includes(id);
                          return (
                            <button
                              key={id}
                              onClick={() => !disabled && setFormat(id)}
                              disabled={disabled}
                              className={cn(
                                "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                                format === id
                                  ? "border-primary/50 bg-primary/10 text-foreground"
                                  : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/50",
                                disabled && "opacity-40 cursor-not-allowed",
                              )}
                            >
                              <Icon className="h-3.5 w-3.5" />
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Duration: Short / Brief */}
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Duration</span>
                      <div className="flex gap-2">
                        {([
                          { id: "short" as const, label: "\u22643 min" },
                          { id: "brief" as const, label: ">3 min" },
                        ]).map(({ id, label }) => (
                          <button
                            key={id}
                            onClick={() => setLength(id)}
                            className={cn(
                              "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                              length === id
                                ? "border-primary/50 bg-primary/10 text-foreground"
                                : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/50",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Language + Speaker stacked */}
                    <div className="space-y-2">
                      <LanguageSelector value={language} onChange={(lang) => {
                        setLanguage(lang);
                        setSpeaker(getDefaultSpeaker(lang));
                      }} />
                      <SpeakerSelector value={speaker} onChange={setSpeaker} language={language} />
                    </div>

                    {/* Brand + Caption stacked */}
                    <div className="space-y-2">
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Brand Name</span>
                        <input
                          type="text"
                          placeholder="Your brand (optional)"
                          value={brandMarkText}
                          onChange={(e) => {
                            setBrandMarkText(e.target.value);
                            setBrandMarkEnabled(e.target.value.trim().length > 0);
                          }}
                          className="flex w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                        />
                      </div>
                      <CaptionStyleSelector value={captionStyle} onChange={setCaptionStyle} />
                    </div>
                  </div>

                  {/* Character Appearance - Collapsible */}
                  <Collapsible open={characterDescOpen} onOpenChange={setCharacterDescOpen}>
                    <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl border border-border/50 bg-card/50 p-3 hover:bg-muted/30 transition-colors">
                      <span className="text-xs font-medium flex items-center gap-2 text-muted-foreground">
                        <Users className="h-3.5 w-3.5" />
                        Character Appearance
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${characterDescOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="rounded-b-xl border border-t-0 border-border/50 bg-card/50 p-4 -mt-1">
                        <CharacterDescriptionInput value={characterDescription} onChange={setCharacterDescription} />
                      </div>
                    </CollapsibleContent>
                  </Collapsible>

                  {/* Visual Style (slideshow) */}
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

                  {/* Credit Cost Display */}
                  <CreditCostDisplay
                    projectType="cinematic"
                    length={length}
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
                    onRegenerate={handleRegenerate}
                    format={generationState.format || format}
                    totalTimeMs={generationState.totalTimeMs}
                    captionStyle={captionStyle}
                    onCaptionStyleChange={setCaptionStyle}
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
                  <div className="w-full max-w-4xl mx-auto">
                    <VideoPlayer
                      exportState={{ status: "idle", progress: 0 }}
                      title={generationState.title || "Untitled Cinematic"}
                      onDownload={() => {}}
                      format={generationState.format || format}
                      generationState={generationState}
                    />
                  </div>

                  {/* Continue Generation button */}
                  {generationState.projectId && (
                    <div className="flex justify-center mt-4">
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
