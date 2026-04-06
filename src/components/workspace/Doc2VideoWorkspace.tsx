import { useState, forwardRef, useImperativeHandle, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Play, AlertCircle, RotateCcw, ChevronDown, Users, Video, Monitor, Smartphone } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WorkspaceLayout } from "@/components/layout/WorkspaceLayout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CinematicSourceInput, type SourceAttachment } from "./CinematicSourceInput";
import { processAttachments } from "@/lib/attachmentProcessor";
import type { VideoFormat } from "./FormatSelector";
import type { VideoLength } from "./LengthSelector";
import { StyleSelector, type VisualStyle } from "./StyleSelector";
import { VoiceSelector, type VoiceSelection } from "./VoiceSelector";
import { LanguageSelector, type Language } from "./LanguageSelector";
import { CaptionStyleSelector, type CaptionStyle } from "./CaptionStyleSelector";
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

import { TemplateSelector } from "./TemplateSelector";
import { useWorkspaceDraft } from "@/hooks/useWorkspaceDraft";

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
    const [sourceAttachments, setSourceAttachments] = useState<SourceAttachment[]>([]);
    const [format, setFormat] = useState<VideoFormat>("portrait");
    const [length, setLength] = useState<VideoLength>("brief");
    const [style, setStyle] = useState<VisualStyle>("minimalist");
    const [customStyle, setCustomStyle] = useState("");
    const [customStyleImage, setCustomStyleImage] = useState<string | null>(null);
    const [voice, setVoice] = useState<VoiceSelection>({ type: "standard", gender: "female" });
    const [language, setLanguage] = useState<Language>("en");
    const [characterDescription, setCharacterDescription] = useState("");
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

    // Load project if projectId provided, or reset if project param removed (tab click)
    useEffect(() => {
      if (initialProjectId) {
        handleOpenProject(initialProjectId);
      } else {
        handleNewProject();
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
        disableExpressions: true,
        characterConsistencyEnabled,
        language,
        projectType: "doc2video",
        // Voice selection - pass gender for standard voices, voiceName for custom
        voiceType: voice.type,
        voiceId: voice.voiceId,
        voiceName: voice.type === "custom" ? voice.voiceName : voice.gender,
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
      setVoice({ type: "standard", gender: "female" });
      setLanguage("en");
      setCharacterDescription("");
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

      // Restore character description
      setCharacterDescription(project.character_description ?? "");
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
                  <div className="space-y-2">
                    <CinematicSourceInput
                      content={content}
                      onContentChange={setContent}
                      attachments={sourceAttachments}
                      onAttachmentsChange={setSourceAttachments}
                    />
                    <TemplateSelector mode="doc2video" onSelectTemplate={setContent} />
                  </div>

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

                    {/* Duration */}
                    <div className="space-y-1.5">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Duration</span>
                      <div className="flex gap-2">
                        {([
                          { id: "short" as const, label: "\u22643 min" },
                          { id: "brief" as const, label: ">3 min" },
                        ]).map(({ id, label }) => {
                          const disabled = disabledLengths.includes(id);
                          return (
                            <button
                              key={id}
                              onClick={() => !disabled && setLength(id)}
                              disabled={disabled}
                              className={cn(
                                "flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors",
                                length === id
                                  ? "border-primary/50 bg-primary/10 text-foreground"
                                  : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/50",
                                disabled && "opacity-40 cursor-not-allowed",
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Language + Voice stacked */}
                    <div className="space-y-2">
                      <LanguageSelector value={language} onChange={setLanguage} />
                      <VoiceSelector selected={voice} onSelect={setVoice} />
                    </div>

                    {/* Caption + Brand stacked */}
                    <div className="space-y-2">
                      <CaptionStyleSelector value={captionStyle} onChange={setCaptionStyle} />
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">Brand Name</span>
                        <input
                          type="text"
                          placeholder="Your brand (optional)"
                          value={brandMarkText}
                          maxLength={50}
                          onChange={(e) => {
                            setBrandMarkText(e.target.value);
                            setBrandMarkEnabled(e.target.value.trim().length > 0);
                          }}
                          className="flex w-full h-9 rounded-md border border-border bg-muted/30 px-3 text-xs placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
                        />
                      </div>
                    </div>
                  </div>

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
