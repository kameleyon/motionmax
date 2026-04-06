import { createScopedLogger } from "@/lib/logger";
import { useState, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Clapperboard } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CinematicSourceInput, type SourceAttachment } from "./CinematicSourceInput";
import { processAttachments } from "@/lib/attachmentProcessor";
import type { VideoFormat } from "./FormatSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import type { SpeakerVoice } from "./SpeakerSelector";
import type { Language } from "./LanguageSelector";
import type { CaptionStyle } from "./CaptionStyleSelector";
import { WorkspaceConfigGrid } from "./WorkspaceConfigGrid";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { InspirationSelector, type InspirationStyle } from "./InspirationSelector";
import { ToneSelector, type StoryTone } from "./ToneSelector";
import { GenreSelector, type StoryGenre } from "./GenreSelector";
import type { StoryLength } from "./StorytellingLengthSelector";
import { GenerationResult } from "./GenerationResult";
import { VideoPlayer } from "./VideoPlayer";
import { CharacterConsistencyToggle } from "./CharacterConsistencyToggle";
import { CreditCostDisplay } from "./CreditCostDisplay";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";

import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";
import { useSubscription, validateGenerationAccess, getCreditsRequired, PLAN_LIMITS } from "@/hooks/useSubscription";
import { toast } from "sonner";
import { UpgradeRequiredModal } from "@/components/modals/UpgradeRequiredModal";
import { SubscriptionSuspendedModal } from "@/components/modals/SubscriptionSuspendedModal";
import { useWorkspaceDraft } from "@/hooks/useWorkspaceDraft";
import type { WorkspaceHandle } from "./types";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";

const log = createScopedLogger("StorytellingWorkspace");

interface StorytellingWorkspaceProps {
  projectId?: string | null;
}

export const StorytellingWorkspace = forwardRef<WorkspaceHandle, StorytellingWorkspaceProps>(
  function StorytellingWorkspace({ projectId: initialProjectId }, ref) {
    // Story-specific inputs
    const [storyIdea, setStoryIdea] = useState("");
    const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
    const [inspiration, setInspiration] = useState<InspirationStyle>("none");
    const [tone, setTone] = useState<StoryTone>("casual");
    const [genre, setGenre] = useState<StoryGenre>("documentary");
    const [characterConsistencyEnabled, setCharacterConsistencyEnabled] = useState(false);
    
    // Shared inputs
    const [format, setFormat] = useState<"landscape" | "portrait">("portrait");
    const [length, setLength] = useState<StoryLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [speaker, setSpeaker] = useState<SpeakerVoice>("Nova");
    const [language, setLanguage] = useState<Language>("en");
    const [characterDescription, setCharacterDescription] = useState("");
    const [characterDescOpen, setCharacterDescOpen] = useState(false);
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");
    const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("none");

    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();
    const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId ?? null, generationState.step);

    // Subscription and plan validation  
    const { plan, creditsBalance, subscriptionStatus, subscriptionEnd, checkSubscription } = useSubscription();
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);
    const [upgradeReason, setUpgradeReason] = useState("");
    const [showSuspendedModal, setShowSuspendedModal] = useState(false);
    const [suspendedStatus, setSuspendedStatus] = useState<"past_due" | "unpaid" | "canceled">("past_due");

    // Auto-save draft to localStorage
    const { clearDraft, loadDraft } = useWorkspaceDraft(
      "storytelling",
      { storyIdea, format, length, style, tone, genre, inspiration, characterDescription },
      generationState.step === "idle"
    );

    // Restore draft on mount if no project loaded
    useEffect(() => {
      if (initialProjectId) return;
      const draft = loadDraft();
      if (draft?.storyIdea) setStoryIdea(draft.storyIdea as string);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const canGenerate = storyIdea.trim().length >= 10 && !generationState.isGenerating;

    // Get disabled formats based on plan (free users can only use landscape)
    const limits = PLAN_LIMITS[plan];
    const disabledFormats: string[] = (["landscape", "portrait"] as const).filter(
      f => !limits.allowedFormats.includes(f)
    );

    // Map plan allowed lengths to story lengths: presentation → extended
    const storyLengthMap: Record<string, StoryLength> = { short: "short", brief: "brief", presentation: "extended" };
    const allowedStoryLengths = limits.allowedLengths.map(l => storyLengthMap[l]).filter(Boolean) as StoryLength[];
    const disabledLengths: StoryLength[] = (["short", "brief", "extended"] as StoryLength[]).filter(
      l => !allowedStoryLengths.includes(l)
    );
    
    // Auto-switch to allowed format/length if current selection becomes disabled
    useEffect(() => {
      // Only auto-switch when user is in form entry (idle) — skip when viewing a loaded project
      if (generationState.step !== "idle") return;
      if (disabledFormats.includes(format) && limits.allowedFormats.length > 0) {
        setFormat(limits.allowedFormats[0] as "landscape" | "portrait");
      }
    }, [plan, format, disabledFormats, limits.allowedFormats, generationState.step]);

    useEffect(() => {
      if (disabledLengths.includes(length) && allowedStoryLengths.length > 0) {
        setLength(allowedStoryLengths[0]);
      }
    }, [plan, length, disabledLengths, allowedStoryLengths]);

    // Load project if projectId provided, or reset if project param removed (tab click)
    useEffect(() => {
      if (initialProjectId) {
        handleOpenProject(initialProjectId);
      } else {
        handleNewProject();
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
      const enrichedContent = storyIdea + attachmentContent;

      startGeneration({
        content: enrichedContent,
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
        disableExpressions: true,
        language,
        brandName: brandMarkText.trim() || undefined,
        characterConsistencyEnabled: plan === "studio" || plan === "enterprise" || characterConsistencyEnabled,
        voiceType: "standard",
        voiceName: speaker,
        captionStyle,
      });

      setTimeout(() => checkSubscription(), 2000);
    };

    const handleNewProject = () => {
      reset();
      setStoryIdea("");
      setSourceAttachments([]);
      setInspiration("none");
      setTone("casual");
      setGenre("documentary");
      setCharacterConsistencyEnabled(false);
      setFormat("portrait");
      setLength("brief");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setSpeaker("Nova");
      setLanguage("en");
      setCharacterDescription("");
      setCharacterDescOpen(false);
      setBrandMarkEnabled(false);
      setBrandMarkText("");
      setCaptionStyle("none");
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setStoryIdea(project.content ?? "");

      const nextFormat = project.format ?? "portrait";
      setFormat(nextFormat === "landscape" ? "landscape" : "portrait");

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
        <span className="text-xs sm:text-sm font-medium text-primary">Creating story...</span>
      </motion.div>
    ) : null;

    return (
      <WorkspaceLayout headerActions={headerActions} mode="storytelling" projectTitle={generationState.title}>
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
                  <CinematicSourceInput
                    content={storyIdea}
                    onContentChange={setStoryIdea}
                    attachments={sourceAttachments}
                    onAttachmentsChange={setSourceAttachments}
                  />

                  {/* Story Settings */}
                  <div className="space-y-4 sm:space-y-6 rounded-xl border border-border/50 bg-card/50 p-4 sm:p-6 backdrop-blur-sm shadow-sm">
                    <InspirationSelector selected={inspiration} onSelect={setInspiration} />
                    <div className="h-px bg-border/30" />
                    <ToneSelector selected={tone} onSelect={setTone} />
                    <div className="h-px bg-border/30" />
                    <GenreSelector selected={genre} onSelect={setGenre} />
                  </div>

                  {/* Compact Configuration Grid */}
                  <WorkspaceConfigGrid
                    format={format}
                    onFormatChange={setFormat}
                    disabledFormats={disabledFormats}
                    duration={length}
                    onDurationChange={(v: string) => setLength(v as StoryLength)}
                    durationOptions={[{ id: "short", label: "\u22643 min" }, { id: "brief", label: ">3 min" }, { id: "extended", label: "<15 min" }]}
                    language={language}
                    onLanguageChange={setLanguage}
                    speaker={speaker}
                    onSpeakerChange={setSpeaker}
                    captionStyle={captionStyle}
                    onCaptionStyleChange={setCaptionStyle}
                    brandMarkText={brandMarkText}
                    onBrandMarkTextChange={(text) => { setBrandMarkText(text); setBrandMarkEnabled(text.trim().length > 0); }}
                  />

                  {/* Character Consistency Toggle - Pro Feature */}
                  <CharacterConsistencyToggle
                    enabled={characterConsistencyEnabled}
                    onToggle={setCharacterConsistencyEnabled}
                  />

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

                  {/* Visual Style */}
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
                    projectType="storytelling"
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
                    title={generationState.title || "Untitled Story"}
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
