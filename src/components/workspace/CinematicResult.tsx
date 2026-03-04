import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import {
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  FolderArchive,
  Link2,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Pencil,
  Copy,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useCinematicRegeneration } from "@/hooks/useCinematicRegeneration";
import { useVideoExport } from "@/hooks/useVideoExport";
import { cn } from "@/lib/utils";
import { CinematicEditModal } from "./CinematicEditModal";
import {
  appendVideoExportLog,
  clearVideoExportLogs,
  formatVideoExportLogs,
  getVideoExportLogs,
} from "@/lib/videoExportDebug";
import JSZip from "jszip";

interface CinematicScene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  imageUrl?: string;
  duration: number;
}

interface CinematicResultProps {
  title: string;
  scenes: CinematicScene[];
  projectId?: string;
  generationId?: string;
  finalVideoUrl?: string;
  onNewProject: () => void;
  format?: "landscape" | "portrait" | "square";
}

function safeFileBase(name: string) {
  return name.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "cinematic";
}

async function waitForCanPlay(el: HTMLMediaElement, timeoutMs = 8000) {
  if (el.readyState >= 3) return;

  await new Promise<void>((resolve, reject) => {
    const to = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for media to load"));
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("Media failed to load"));
    };

    const cleanup = () => {
      window.clearTimeout(to);
      el.removeEventListener("canplay", onReady);
      el.removeEventListener("canplaythrough", onReady);
      el.removeEventListener("loadeddata", onReady);
      el.removeEventListener("error", onError);
    };

    el.addEventListener("canplay", onReady, { once: true });
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("loadeddata", onReady, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

export function CinematicResult({
  title,
  scenes,
  projectId,
  generationId,
  finalVideoUrl,
  onNewProject,
  format = "landscape",
}: CinematicResultProps) {
  const navigate = useNavigate();

  // Compute aspect ratio class from format
  const aspectClass = format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video";

  const [localScenes, setLocalScenes] = useState<CinematicScene[]>(scenes);
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const [sceneProgress, setSceneProgress] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  // Download states
  const [isDownloadingClipsZip, setIsDownloadingClipsZip] = useState(false);

  // Video export (same engine as explainer)
  const { state: exportState, exportVideo, downloadVideo, reset: resetExport } = useVideoExport();
  const shouldAutoDownloadRef2 = useRef(false);
  const lastAutoDownloadedUrlRef = useRef<string | null>(null);
  const [showExportLogs, setShowExportLogs] = useState(false);
  const [exportLogsVersion, setExportLogsVersion] = useState(0);

  const exportLogText = (() => {
    void exportLogsVersion;
    return formatVideoExportLogs(getVideoExportLogs());
  })();

  // Edit dialog
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editVoiceover, setEditVoiceover] = useState("");
  const [editVisualPrompt, setEditVisualPrompt] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Share/delete dialogs
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [displayUrl, setDisplayUrl] = useState("");
  const [isCreatingShare, setIsCreatingShare] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasCopied, setHasCopied] = useState(false);

  // Media refs
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playRunIdRef = useRef(0);
  const restartRef = useRef(true);
  const advancedFromSceneRef = useRef<number | null>(null);

  // Keep local scenes synced with props
  useEffect(() => {
    setLocalScenes(scenes);
  }, [scenes]);

  // Auto-download when export completes (same as explainer)
  useEffect(() => {
    if (!shouldAutoDownloadRef2.current) return;
    if (exportState.status !== "complete" || !exportState.videoUrl) return;
    if (lastAutoDownloadedUrlRef.current === exportState.videoUrl) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      shouldAutoDownloadRef2.current = false;
      lastAutoDownloadedUrlRef.current = exportState.videoUrl;
      return;
    }

    lastAutoDownloadedUrlRef.current = exportState.videoUrl;
    shouldAutoDownloadRef2.current = false;

    const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "cinematic";
    downloadVideo(exportState.videoUrl, `${safeName}.mp4`);
  }, [downloadVideo, exportState.status, exportState.videoUrl, title]);

  const isExporting = exportState.status === "loading" || exportState.status === "rendering" || exportState.status === "encoding";



  const currentScene = localScenes[currentSceneIndex];

  const scenesWithVideo = useMemo(
    () => localScenes.filter((s) => !!s.videoUrl),
    [localScenes]
  );

  const goToNextScene = () => {
    if (currentSceneIndex < localScenes.length - 1) {
      setCurrentSceneIndex((i) => i + 1);
      setSceneProgress(0);
    }
  };

  const goToPrevScene = () => {
    if (currentSceneIndex > 0) {
      setCurrentSceneIndex((i) => i - 1);
      setSceneProgress(0);
    }
  };

  const stop = useCallback(() => {
    const v = previewVideoRef.current;
    const a = audioRef.current;

    if (v) {
      v.pause();
      try {
        v.currentTime = 0;
      } catch {
        // ignore
      }
    }

    if (a) {
      a.pause();
      try {
        a.currentTime = 0;
      } catch {
        // ignore
      }
      a.removeAttribute("src");
      a.load();
    }

    setIsPlayingAll(false);
    setSceneProgress(0);
    restartRef.current = true;
    advancedFromSceneRef.current = null;
  }, []);

  // Regeneration hook (mirrors useSceneRegeneration pattern with fetch())
  const {
    isRegenerating,
    regenerateAudio,
    regenerateVideo,
    applyImageEdit,
    regenerateImage,
  } = useCinematicRegeneration(
    generationId,
    projectId,
    localScenes,
    setLocalScenes,
    stop
  );

  const startPlayAll = useCallback(
    (startIndex: number) => {
      const scene = localScenes[startIndex];
      if (!scene?.videoUrl) {
        toast({
          variant: "destructive",
          title: "No video",
          description: "This scene has no clip to play.",
        });
        return;
      }

      restartRef.current = true;
      advancedFromSceneRef.current = null;
      setSceneProgress(0);
      setCurrentSceneIndex(startIndex);
      setIsPlayingAll(true);
    },
    [localScenes]
  );

  const pause = useCallback(() => {
    previewVideoRef.current?.pause();
    audioRef.current?.pause();
    setIsPlayingAll(false);
  }, []);

  const resume = useCallback(() => {
    if (!currentScene?.videoUrl) return;
    restartRef.current = false;
    setIsPlayingAll(true);
  }, [currentScene?.videoUrl]);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => {
      const next = !m;
      if (audioRef.current) audioRef.current.muted = next;
      return next;
    });
  }, []);

  // Core play loop
  useEffect(() => {
    if (!isPlayingAll) return;

    const scene = localScenes[currentSceneIndex];
    const video = previewVideoRef.current;
    const audio = audioRef.current;

    if (!scene?.videoUrl || !video) {
      setIsPlayingAll(false);
      return;
    }

    const runId = ++playRunIdRef.current;
    const shouldRestart = restartRef.current;
    restartRef.current = false;

    const run = async () => {
      video.muted = true;
      video.playsInline = true;

      if (!video.currentSrc || !video.currentSrc.includes(scene.videoUrl)) {
        video.src = scene.videoUrl;
        video.load();
      }

      if (shouldRestart) {
        try { video.currentTime = 0; } catch { /* ignore */ }
      }

      if (audio) {
        if (scene.audioUrl) {
          if (audio.src !== scene.audioUrl) {
            audio.src = scene.audioUrl;
            audio.load();
          }
          audio.muted = isMuted;
          if (shouldRestart) {
            try { audio.currentTime = 0; } catch { /* ignore */ }
          }
        } else {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
      }

      try {
        await waitForCanPlay(video);
        if (runId !== playRunIdRef.current) return;

        await video.play();

        if (audio && scene.audioUrl) {
          try {
            await waitForCanPlay(audio);
            if (runId !== playRunIdRef.current) return;
            await audio.play();
          } catch {
            // If audio fails, keep video going.
          }
        }
      } catch (e) {
        console.error("[CinematicResult] Playback failed", e);
        if (runId !== playRunIdRef.current) return;
        setIsPlayingAll(false);
        toast({
          variant: "destructive",
          title: "Playback blocked",
          description: "Tap Play again to start playback.",
        });
      }
    };

    void run();
  }, [isPlayingAll, currentSceneIndex, isMuted, localScenes]);

  const advanceToNextScene = useCallback(() => {
    if (!isPlayingAll) return;
    if (advancedFromSceneRef.current === currentSceneIndex) return;
    advancedFromSceneRef.current = currentSceneIndex;

    const nextIndex = currentSceneIndex + 1;
    if (nextIndex >= localScenes.length) {
      stop();
      return;
    }

    restartRef.current = true;
    setSceneProgress(0);
    setCurrentSceneIndex(nextIndex);
  }, [currentSceneIndex, isPlayingAll, localScenes.length, stop]);

  const handleVideoEnded = useCallback(() => { advanceToNextScene(); }, [advanceToNextScene]);
  const handleAudioEnded = useCallback(() => { advanceToNextScene(); }, [advanceToNextScene]);

  const handleVideoTimeUpdate = useCallback(() => {
    if (!isPlayingAll) return;
    const video = previewVideoRef.current;
    if (!video) return;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : currentScene?.duration || 1;
    setSceneProgress(Math.min(1, (video.currentTime || 0) / dur));
  }, [currentScene?.duration, isPlayingAll]);

  // ===== Downloads =====
  const downloadFromUrl = useCallback(async (url: string, filename: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }, []);

  // Primary export handler: client-side rendering (same engine as explainer)
  const handleExportVideo = useCallback(() => {
    const hasVideos = localScenes.some((s) => !!s.videoUrl);
    if (!hasVideos) {
      toast({ variant: "destructive", title: "No videos", description: "Generate video clips first." });
      return;
    }
    clearVideoExportLogs();
    appendVideoExportLog("log", [
      "[UI] Cinematic export started",
      { scenes: localScenes.length, format },
    ]);
    setExportLogsVersion((v) => v + 1);
    shouldAutoDownloadRef2.current = true;
    // Map CinematicScene to the Scene type expected by useVideoExport
    const exportScenes = localScenes.map((s) => ({
      number: s.number,
      voiceover: s.voiceover,
      visualPrompt: s.visualPrompt,
      duration: s.duration,
      videoUrl: s.videoUrl,
      audioUrl: s.audioUrl,
      imageUrl: s.imageUrl,
    }));
    void exportVideo(exportScenes, format).catch(() => {
      setExportLogsVersion((v) => v + 1);
    });
  }, [localScenes, format, exportVideo]);

  const handleDownloadClipsZip = useCallback(async () => {
    if (scenesWithVideo.length === 0) return;
    setIsDownloadingClipsZip(true);
    try {
      const zip = new JSZip();
      for (const scene of scenesWithVideo) {
        if (!scene.videoUrl) continue;
        const videoResp = await fetch(scene.videoUrl);
        if (videoResp.ok) zip.file(`scene-${scene.number}.mp4`, await videoResp.blob());
        if (scene.audioUrl) {
          const audioResp = await fetch(scene.audioUrl);
          if (audioResp.ok) zip.file(`scene-${scene.number}-audio.wav`, await audioResp.blob());
        }
      }
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFileBase(title)}-clips.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Download complete", description: "Clips ZIP downloaded." });
    } catch (e) {
      console.error("Clips ZIP download failed", e);
      toast({ variant: "destructive", title: "Download failed", description: "Please try again." });
    } finally {
      setIsDownloadingClipsZip(false);
    }
  }, [scenesWithVideo, title]);

  // ===== Share =====
  const handleShare = useCallback(async () => {
    if (!projectId) {
      toast({ title: "Cannot share", description: "Project must be saved first", variant: "destructive" });
      return;
    }
    setIsShareDialogOpen(true);
    setIsCreatingShare(true);
    setHasCopied(false);
    try {
      const { data: existingShare } = await supabase
        .from("project_shares")
        .select("share_token")
        .eq("project_id", projectId)
        .maybeSingle();
      let token = existingShare?.share_token;
      if (!token) {
        token = crypto.randomUUID();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Not authenticated");
        const { error } = await supabase.from("project_shares").insert({
          project_id: projectId,
          user_id: user.id,
          share_token: token,
        });
        if (error) throw error;
      }
      const backendUrl = import.meta.env.VITE_SUPABASE_URL;
      const metaUrl = `${backendUrl}/functions/v1/share-meta?token=${token}&v=${Date.now()}`;
      setShareUrl(metaUrl);
      setDisplayUrl(`https://motionmax.io/share/${token}`);
    } catch (e) {
      console.error("Failed to create share", e);
      toast({ title: "Failed to create share link", description: "Please try again", variant: "destructive" });
      setIsShareDialogOpen(false);
    } finally {
      setIsCreatingShare(false);
    }
  }, [projectId]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayUrl);
      setHasCopied(true);
      toast({ title: "Link copied!", description: "Share this link with anyone" });
      window.setTimeout(() => setHasCopied(false), 2000);
    } catch {
      toast({ title: "Failed to copy", description: "Please copy the link manually", variant: "destructive" });
    }
  }, [displayUrl]);

  // ===== Delete =====
  const handleDelete = useCallback(async () => {
    if (!projectId) return;
    setIsDeleting(true);
    try {
      await supabase.from("generations").delete().eq("project_id", projectId);
      await supabase.from("project_shares").delete().eq("project_id", projectId);
      await supabase.from("project_characters").delete().eq("project_id", projectId);
      const { error } = await supabase.from("projects").delete().eq("id", projectId);
      if (error) throw error;
      navigate("/projects", { replace: true });
      toast({ title: "Project deleted", description: "Your project has been permanently deleted" });
    } catch (e) {
      console.error("Delete failed", e);
      toast({ title: "Failed to delete", description: "Please try again", variant: "destructive" });
    } finally {
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  }, [navigate, projectId]);

  // ===== Edit =====
  const openEdit = useCallback(() => {
    const s = currentScene;
    if (!s) return;
    setEditVoiceover(s.voiceover ?? "");
    setEditVisualPrompt(s.visualPrompt ?? "");
    setIsEditOpen(true);
  }, [currentScene]);

  const persistScenes = useCallback(
    async (nextScenes: CinematicScene[]) => {
      if (!generationId) return;
      const { error } = await supabase.from("generations").update({ scenes: nextScenes as any }).eq("id", generationId);
      if (error) throw error;
    },
    [generationId]
  );

  const saveEdit = useCallback(async () => {
    if (!currentScene) return;
    setIsSavingEdit(true);
    try {
      const nextScenes = localScenes.map((s, idx) =>
        idx === currentSceneIndex ? { ...s, voiceover: editVoiceover, visualPrompt: editVisualPrompt } : s
      );
      setLocalScenes(nextScenes);
      await persistScenes(nextScenes);
      toast({ title: "Saved", description: "Scene updated." });
      setIsEditOpen(false);
    } catch (e) {
      console.error("Save edit failed", e);
      toast({ variant: "destructive", title: "Save failed", description: "Please try again." });
    } finally {
      setIsSavingEdit(false);
    }
  }, [currentScene, currentSceneIndex, editVoiceover, editVisualPrompt, localScenes, persistScenes]);

  const canEdit = !!generationId;
  const regenBusy = isRegenerating?.sceneIndex === currentSceneIndex;

  return (
    <div className="space-y-6">
      <audio ref={audioRef} className="hidden" preload="auto" onEnded={handleAudioEnded} />

      {/* Header */}
      <div className="text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-4">
          <Film className="h-4 w-4" />
          Complete • {scenesWithVideo.length} clips
        </div>

        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>

        {/* Playback Controls */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {!isPlayingAll ? (
            <Button onClick={() => startPlayAll(currentSceneIndex)} className="gap-2" disabled={!currentScene?.videoUrl}>
              <Play className="h-4 w-4" />
              Play All
            </Button>
          ) : (
            <Button onClick={pause} className="gap-2">
              <Pause className="h-4 w-4" />
              Pause
            </Button>
          )}

          <Button variant="outline" onClick={resume} className="gap-2" disabled={isPlayingAll || !currentScene?.videoUrl}>
            <Play className="h-4 w-4" />
            Resume
          </Button>

          <Button variant="outline" onClick={stop} className="gap-2" disabled={!isPlayingAll}>
            <Square className="h-4 w-4" />
            Stop
          </Button>

          <Button variant="outline" size="icon" onClick={toggleMute} className="h-10 w-10" title={isMuted ? "Unmute narration" : "Mute narration"}>
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Current Scene Preview */}
      <Card className="overflow-hidden border-border/50 bg-card/50 backdrop-blur-sm max-w-3xl mx-auto">
        <div className={`relative ${aspectClass} bg-muted/50 flex items-center justify-center`}>
          {/* Progress bar */}
          <div className="absolute inset-x-0 top-0 z-10 h-1 bg-background/30">
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${Math.round(sceneProgress * 100)}%` }}
            />
          </div>

          {currentScene?.videoUrl ? (
            <video
              ref={previewVideoRef}
              src={currentScene.videoUrl}
              className="w-full h-full object-cover"
              muted
              playsInline
              autoPlay={false}
              loop={false}
              controls={!isPlayingAll}
              onEnded={handleVideoEnded}
              onTimeUpdate={handleVideoTimeUpdate}
              preload="auto"
            />
          ) : currentScene?.imageUrl ? (
            <img
              src={currentScene.imageUrl}
              alt={`Scene ${currentScene.number}`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="text-center text-muted-foreground">
              <Film className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No video for Scene {currentScene?.number}</p>
            </div>
          )}

          {/* Scene Navigation */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background/80 to-transparent p-4">
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="icon" onClick={goToPrevScene} disabled={currentSceneIndex === 0}>
                <ChevronLeft className="h-6 w-6" />
              </Button>

              <div className="flex items-center gap-2">
                {localScenes.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentSceneIndex(idx)}
                    className={`h-2 rounded-full transition-all ${
                      idx === currentSceneIndex ? "w-6 bg-primary" : "w-2 bg-muted-foreground/40 hover:bg-muted-foreground/60"
                    }`}
                    aria-label={`Go to scene ${idx + 1}`}
                  />
                ))}
              </div>

              <Button variant="ghost" size="icon" onClick={goToNextScene} disabled={currentSceneIndex === localScenes.length - 1}>
                <ChevronRight className="h-6 w-6" />
              </Button>
            </div>
          </div>
        </div>

        {/* Scene Details */}
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">
              Scene {currentScene?.number}
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{currentScene?.duration}s</span>
              <Button
                type="button"
                size="sm"
                onClick={openEdit}
                disabled={!canEdit || isSavingEdit}
                className="gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>
          </div>
          
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Volume2 className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                {currentScene?.voiceover}
              </p>
            </div>

            {currentScene?.audioUrl ? (
              <audio
                key={currentScene.audioUrl}
                controls
                preload="none"
                src={currentScene.audioUrl}
                onPlay={() => {
                  if (isPlayingAll) stop();
                }}
                className="w-full"
              />
            ) : null}
          </div>
        </div>
      </Card>

      {/* All Scenes Grid */}
      <div className="space-y-4 max-w-3xl mx-auto">
        <h3 className="text-lg font-medium text-foreground">All Scenes</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {localScenes.map((scene, idx) => (
            <button
              type="button"
              key={scene.number}
              onClick={() => setCurrentSceneIndex(idx)}
              className={cn(
                "relative rounded-lg overflow-hidden border transition-all",
                aspectClass,
                idx === currentSceneIndex
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border/50 hover:border-border"
              )}
            >
              {scene.videoUrl ? (
                <video
                  src={scene.videoUrl}
                  className="w-full h-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : scene.imageUrl ? (
                <img
                  src={scene.imageUrl}
                  alt={`Scene ${scene.number}`}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full bg-muted/50 flex items-center justify-center">
                  <Film className="h-8 w-8 text-muted-foreground/50" />
                </div>
              )}
              <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white">
                {scene.duration}s
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Export Progress */}
      {isExporting && (
        <div className="max-w-3xl mx-auto">
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                {exportState.status === "loading" && "Loading scenes..."}
                {exportState.status === "rendering" && "Rendering video..."}
                {exportState.status === "encoding" && "Finalizing..."}
              </span>
              <span className="text-sm text-muted-foreground">{exportState.progress}%</span>
            </div>
            <Progress value={exportState.progress} className="h-2" />
            {exportState.warning && (
              <p className="text-xs text-muted-foreground">{exportState.warning}</p>
            )}
          </Card>
        </div>
      )}

      {/* Export Complete */}
      {exportState.status === "complete" && exportState.videoUrl && (
        <div className="max-w-3xl mx-auto">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-primary">Video ready!</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    const safeName = title.replace(/[^a-z0-9]/gi, "_").slice(0, 50) || "cinematic";
                    downloadVideo(exportState.videoUrl!, `${safeName}.mp4`);
                  }}
                  className="gap-1.5"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowExportLogs(true)}
                >
                  Logs
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Export Error */}
      {exportState.status === "error" && (
        <div className="max-w-3xl mx-auto">
          <Card className="p-4 border-destructive/50">
            <div className="flex items-center justify-between">
              <span className="text-sm text-destructive">Export failed: {exportState.error}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowExportLogs(true)}>
                  Logs
                </Button>
                <Button variant="outline" size="sm" onClick={resetExport}>
                  Dismiss
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Action Bar */}
      <TooltipProvider delayDuration={300}>
        <div className="rounded-2xl border border-border/50 bg-card/50 backdrop-blur-sm p-3 max-w-3xl mx-auto">
          <div className="flex items-center justify-center gap-2">
            {/* Export Video — client-side rendering (same as explainer) */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  onClick={handleExportVideo}
                  disabled={isExporting || !scenesWithVideo.length}
                  className="h-10 w-10"
                >
                  {isExporting ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Download className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isExporting
                  ? `Rendering ${exportState.progress}%...`
                  : scenesWithVideo.length
                    ? "Export Video"
                    : "No video clips available"}
              </TooltipContent>
            </Tooltip>

            {/* Download Clips ZIP */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleDownloadClipsZip}
                  disabled={isDownloadingClipsZip || scenesWithVideo.length === 0}
                  className="h-10 w-10"
                >
                  {isDownloadingClipsZip ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <FolderArchive className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download Clips (ZIP)</TooltipContent>
            </Tooltip>

            {/* Share */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleShare}
                  disabled={!projectId}
                  className="h-10 w-10"
                >
                  <Link2 className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Share</TooltipContent>
            </Tooltip>

            {/* Regenerate Clip */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    if (projectId && generationId) {
                      regenerateVideo(currentSceneIndex);
                    }
                  }}
                  disabled={!projectId || !generationId || !!isRegenerating}
                  className="h-10 w-10"
                >
                  {isRegenerating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-5 w-5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Regenerate Clip</TooltipContent>
            </Tooltip>

            {/* New Project */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={onNewProject} className="h-10 w-10">
                  <Plus className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New Project</TooltipContent>
            </Tooltip>

            {/* Delete */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={!projectId}
                  className="h-10 w-10 text-muted-foreground hover:text-destructive hover:border-destructive/50"
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete Project</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* Edit Modal */}
      {isEditOpen && currentScene && (
        <CinematicEditModal
          scene={currentScene}
          sceneIndex={currentSceneIndex}
          format={format}
          onClose={() => setIsEditOpen(false)}
          onRegenerateAudio={regenerateAudio}
          onRegenerateVideo={(idx) => regenerateVideo(idx)}
          onApplyImageEdit={applyImageEdit}
          onRegenerateImage={regenerateImage}
          isRegenerating={!!isRegenerating && isRegenerating.sceneIndex === currentSceneIndex}
          regeneratingType={isRegenerating?.sceneIndex === currentSceneIndex ? isRegenerating.type : null}
        />
      )}

      {/* Share Dialog */}
      <Dialog open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Cinematic</DialogTitle>
            <DialogDescription>Anyone with this link can view your video.</DialogDescription>
          </DialogHeader>

          {isCreatingShare ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Input value={displayUrl} readOnly className="flex-1 text-sm" />
                <Button onClick={handleCopyLink} className="shrink-0">
                  {hasCopied ? "Copied!" : "Copy Link"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">This link will remain active until you delete the project.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export Logs Modal */}
      {showExportLogs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <Card className="w-full max-w-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-foreground">Export Logs</h3>
              <Button variant="ghost" size="icon" onClick={() => setShowExportLogs(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(exportLogText || ""); } catch {}
                }}
                disabled={!exportLogText}
              >
                <Copy className="h-4 w-4" />
                Copy
              </Button>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => { clearVideoExportLogs(); setExportLogsVersion((v) => v + 1); }}
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </Button>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3 max-h-[60vh] overflow-auto">
              <pre className="text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                {exportLogText || "No export logs captured yet."}
              </pre>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
