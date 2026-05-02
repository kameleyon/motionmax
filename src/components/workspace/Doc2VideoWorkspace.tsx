import { useState, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Video } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CinematicSourceInput, type SourceAttachment } from "./CinematicSourceInput";
import { processAttachments } from "@/lib/attachmentProcessor";
import type { VideoFormat } from "./FormatSelector";
import type { VideoLength } from "./LengthSelector";
import { toVideoLength } from "@/types/domain";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import type { SpeakerVoice } from "./SpeakerSelector";
import type { Language } from "./LanguageSelector";
import type { CaptionStyle } from "./CaptionStyleSelector";
import { WorkspaceConfigGrid } from "./WorkspaceConfigGrid";
import { CharacterDescriptionInput } from "./CharacterDescriptionInput";
import { CharacterConsistencyToggle } from "./CharacterConsistencyToggle";
import { GenerationResult } from "./GenerationResult";
import { VideoPlayer } from "./VideoPlayer";
import { CreditCostDisplay } from "./CreditCostDisplay";
import { useGenerationPipeline } from "@/hooks/useGenerationPipeline";
import { useAdminLogs } from "@/hooks/useAdminLogs";
import { AdminLogsPanel } from "./AdminLogsPanel";
import { useWorkspaceSubscription } from "@/hooks/useWorkspaceSubscription";
import { WorkspaceModals } from "./WorkspaceModals";

import { useWorkspaceDraft } from "@/hooks/useWorkspaceDraft";

import { getUserFriendlyErrorMessage } from "@/lib/errorMessages";

import type { WorkspaceHandle } from "./types";
export type { WorkspaceHandle } from "./types";

interface Doc2VideoWorkspaceProps {
  projectId?: string | null;
  autostart?: boolean;
  onAutostartConsumed?: () => void;
}

export const Doc2VideoWorkspace = forwardRef<WorkspaceHandle, Doc2VideoWorkspaceProps>(
  function Doc2VideoWorkspace({ projectId: initialProjectId, autostart, onAutostartConsumed }, ref) {
    const [content, setContent] = useState("");
    const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
    const [format, setFormat] = useState<"landscape" | "portrait">("portrait");
    const [length, setLength] = useState<VideoLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [speaker, setSpeaker] = useState<SpeakerVoice>("Adam");
    const [language, setLanguage] = useState<Language>("en");
    const [characterDescription, setCharacterDescription] = useState("");
    const [characterImages, setCharacterImages] = useState<string[]>([]);
    const [characterDescOpen, setCharacterDescOpen] = useState(false);
    const [brandMarkEnabled, setBrandMarkEnabled] = useState(false);
    const [brandMarkText, setBrandMarkText] = useState("");
    const [characterConsistencyEnabled, setCharacterConsistencyEnabled] = useState(false);
    const [captionStyle, setCaptionStyle] = useState<CaptionStyle>("none");

    const { state: generationState, startGeneration, reset, loadProject } = useGenerationPipeline();
    const { isAdmin, adminLogs, showAdminLogs, setShowAdminLogs } = useAdminLogs(generationState.generationId ?? null, generationState.step);

    // Subscription and plan validation (shared hook eliminates boilerplate)
    const {
      plan, creditsBalance, checkSubscription, limits,
      modalState, closeUpgradeModal, closeSuspendedModal, guardGeneration,
    } = useWorkspaceSubscription();

    // Auto-save draft to localStorage
    const { clearDraft, loadDraft, hasDraft } = useWorkspaceDraft(
      "doc2video",
      { content, format, length, style, customStyle, characterDescription, brandMarkText },
      generationState.step === "idle"
    );

    // Restore draft on mount if no project loaded
    useEffect(() => {
      if (initialProjectId) return;
      const draft = loadDraft();
      if (draft) {
        if (draft.content) setContent(draft.content as string);
        if (draft.characterDescription) { setCharacterDescription(draft.characterDescription as string); setCharacterDescOpen(true); }
      }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const canGenerate = content.trim().length >= 10 && !generationState.isGenerating;

    // Disable formats/lengths based on plan
    const disabledFormats: string[] = (["landscape", "portrait"] as const).filter(
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
        setFormat(limits.allowedFormats[0] as "landscape" | "portrait");
      }
    }, [plan, format, disabledFormats, limits.allowedFormats, generationState.step]);

    useEffect(() => {
      if (disabledLengths.includes(length) && limits.allowedLengths.length > 0) {
        setLength(limits.allowedLengths[0] as VideoLength);
      }
    }, [plan, length, disabledLengths, limits.allowedLengths]);

    // Load project if projectId provided, or reset if project param removed (tab click)
    useEffect(() => {
      if (initialProjectId) {
        void (async () => {
          await handleOpenProject(initialProjectId);
          if (autostart) {
            onAutostartConsumed?.();
            setTimeout(() => { void handleGenerate(); }, 50);
          }
        })();
      } else {
        handleNewProject();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const runGeneration = async () => {
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
        characterImages: characterImages.length > 0 ? characterImages : undefined,
        // Match Cinematic's behaviour: character consistency always
        // ON, expressions enabled. Worker handlers (handleCinematicImage)
        // already accept both regardless of project_type — the gate
        // here was the only thing keeping Free/Starter Explainer users
        // from getting consistent character renders.
        disableExpressions: false,
        characterConsistencyEnabled: true,
        language,
        projectType: "doc2video",
        voiceType: "standard",
        voiceName: speaker,
        captionStyle,
      });
    };

    const handleGenerate = () => {
      if (content.trim().length === 0) return;
      if (generationState.isGenerating) return;

      const canProceed = guardGeneration({
        projectType: "doc2video",
        length,
        format,
        hasBrandMark: brandMarkEnabled && brandMarkText.trim().length > 0,
        hasCustomStyle: style === "custom",
      });
      if (!canProceed) return;

      runGeneration();
      setTimeout(() => checkSubscription(), 2000);
    };

    const handleRetry = () => {
      if (content.trim().length === 0) return;
      reset();
      runGeneration();
    };

    const handleNewProject = () => {
      reset();
      setContent("");
      setSourceAttachments([]);
      setFormat("portrait");
      setLength("brief");
      setStyle("minimalist");
      setCustomStyle("");
      setCustomStyleImage(null);
      setSpeaker("Adam");
      setLanguage("en");
      setCharacterDescription("");
      setCharacterImages([]);
      setCharacterDescOpen(false);
      setBrandMarkEnabled(false);
      setBrandMarkText("");
      setCharacterConsistencyEnabled(false);
      setCaptionStyle("none");
    };

    const handleOpenProject = async (projectId: string) => {
      const project = await loadProject(projectId);
      if (!project) return;

      setContent(project.content ?? "");

      const nextFormat = project.format ?? "portrait";
      setFormat(nextFormat === "landscape" ? "landscape" : "portrait");

      const nextLength = toVideoLength(project.length);
      setLength(nextLength);

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
        setCustomStyle(project.custom_style ?? "");
        setCustomStyleImage(project.custom_style_image ?? null);
      } else {
        setStyle("custom");
        setCustomStyle(project.custom_style ?? project.style);
        setCustomStyleImage(project.custom_style_image ?? null);
      }

      // Restore character description + image
      setCharacterDescription(project.character_description ?? "");
      setCharacterImages(project.character_images ?? []);
      if (project.character_description || (project.character_images?.length)) setCharacterDescOpen(true);

      // Restore voice settings
      if (project.voice_name) {
        setSpeaker(project.voice_name as SpeakerVoice);
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
      <WorkspaceLayout headerActions={headerActions} mode="doc2video" projectTitle={generationState.title}>
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
                    disabledFormats={disabledFormats}
                    duration={length}
                    onDurationChange={(v: string) => setLength(v as VideoLength)}
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
                        <CharacterDescriptionInput value={characterDescription} onChange={setCharacterDescription} images={characterImages} onImagesChange={setCharacterImages} />
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
                  />

                  {/* Credit Cost Display */}
                  <CreditCostDisplay
                    projectType="doc2video"
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
                    title={generationState.title || "Untitled Video"}
                    onDownload={() => {}}
                    format={generationState.format || format}
                    generationState={generationState}
                  />
                  {isAdmin && <AdminLogsPanel logs={adminLogs} show={showAdminLogs} onToggle={() => setShowAdminLogs(!showAdminLogs)} />}
                </motion.div>
              )}
            </AnimatePresence>

        {/* Modals */}
        <WorkspaceModals
          plan={plan}
          showUpgradeModal={modalState.showUpgradeModal}
          upgradeReason={modalState.upgradeReason}
          showSuspendedModal={modalState.showSuspendedModal}
          suspendedStatus={modalState.suspendedStatus}
          onUpgradeModalChange={closeUpgradeModal}
          onSuspendedModalChange={closeSuspendedModal}
        />
      </WorkspaceLayout>
    );
  }
);
