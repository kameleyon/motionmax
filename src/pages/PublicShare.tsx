import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { motion } from "framer-motion";
import {
  Loader2,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ThemedLogo } from "@/components/ThemedLogo";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

interface Scene {
  videoUrl?: string;
  imageUrl?: string;
  imageUrls?: string[];
  audioUrl?: string;
  duration?: number;
  narration?: string;
  voiceover?: string;
}

// Header CTA component - Get Started button (icon on mobile/tablet)
function HeaderCTA() {
  const isMobile = useIsMobile();

  return (
    <Button asChild size={isMobile ? "icon" : "sm"} variant="default">
      <Link to="/">{isMobile ? <Sparkles className="h-5 w-5" /> : "Get Started"}</Link>
    </Button>
  );
}

export default function PublicShare() {
  const { token } = useParams<{ token: string }>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch share data using backend function for fresh signed URLs
  const { data: shareData, isLoading, error } = useQuery({
    queryKey: ["public-share", token],
    queryFn: async () => {
      if (!token) throw new Error("Invalid share link");

      const { data, error } = await supabase.functions.invoke("get-shared-project", {
        body: { token },
      });

      if (error) throw error;
      if (!data) throw new Error("Share not found or expired");

      return {
        project: data.project,
        scenes: (data.scenes || []) as Scene[],
        share: data.share,
        videoUrl: (data.videoUrl ?? data.video_url) as string | undefined,
      };
    },
    enabled: !!token,
    retry: false,
  });

  const scenes = shareData?.scenes || [];
  const project = shareData?.project as any;
  const sharedVideoUrl = shareData?.videoUrl;
  const isSingleVideo = !!sharedVideoUrl;

  const currentScene = scenes[currentSceneIndex];

  // Get all images for current scene
  const getCurrentSceneImages = (scene: Scene | undefined): string[] => {
    if (!scene) return [];
    if (scene.imageUrls && scene.imageUrls.length > 0) return scene.imageUrls;
    if (scene.imageUrl) return [scene.imageUrl];
    return [];
  };

  const currentSceneImages = getCurrentSceneImages(currentScene);
  const currentImageUrl = currentSceneImages[currentImageIndex] || currentSceneImages[0] || "";

  // Total duration
  useEffect(() => {
    if (isSingleVideo) return;
    if (scenes.length > 0) {
      const total = scenes.reduce((acc, scene) => acc + (scene.duration || 3), 0);
      setTotalDuration(total);
    }
  }, [isSingleVideo, scenes]);

  // ===== Single-video playback =====
  useEffect(() => {
    if (!isSingleVideo) return;

    const video = videoRef.current;
    if (!video) return;

    const onLoaded = () => {
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      setTotalDuration(dur);
    };

    const onTimeUpdate = () => {
      if (isSeeking) return;
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Math.max(totalDuration, 1);
      setProgress(Math.min(100, ((video.currentTime || 0) / dur) * 100));
    };

    const onEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      try {
        video.currentTime = 0;
      } catch {
        // ignore
      }
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);

    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, [isSingleVideo, totalDuration, isSeeking]);

  useEffect(() => {
    if (!isSingleVideo) return;

    const video = videoRef.current;
    if (!video) return;

    video.muted = isMuted;

    if (!isPlaying) {
      video.pause();
      return;
    }

    video.play().catch(() => {
      setIsPlaying(false);
    });
  }, [isSingleVideo, isMuted, isPlaying]);

  // ===== Per-scene playback (with video) =====
  useEffect(() => {
    if (isSingleVideo) return;
    if (!isPlaying || !currentScene) return;
    if (!currentScene.videoUrl) return;

    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return;

    const previousDuration = scenes
      .slice(0, currentSceneIndex)
      .reduce((acc, s) => acc + (s.duration || 3), 0);

    video.muted = true;
    video.src = currentScene.videoUrl;
    video.currentTime = 0;
    video.playsInline = true;
    video.load();

    if (audio && currentScene.audioUrl) {
      audio.src = currentScene.audioUrl;
      audio.muted = isMuted;
      audio.currentTime = 0;
      audio.load();
    } else if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    const handleTimeUpdate = () => {
      if (isSeeking) return;
      // Sync progress from audio if available, else from video
      const source = (audio && currentScene.audioUrl) ? audio : video;
      const elapsed = source.currentTime || 0;
      const pct = ((previousDuration + elapsed) / Math.max(totalDuration, 1)) * 100;
      setProgress(Math.min(pct, 100));
    };

    const handleEnded = () => {
      if (currentSceneIndex < scenes.length - 1) {
        setCurrentSceneIndex(currentSceneIndex + 1);
        setCurrentImageIndex(0);
      } else {
        setIsPlaying(false);
        setCurrentSceneIndex(0);
        setCurrentImageIndex(0);
        setProgress(0);
      }
    };

    // Prefer audio timeupdate for sync accuracy; fall back to video
    const syncSource = (audio && currentScene.audioUrl) ? audio : video;
    syncSource.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("ended", handleEnded);
    if (audio && currentScene.audioUrl) {
      audio.addEventListener("ended", handleEnded);
    }

    (async () => {
      try {
        await video.play();
        if (audio && currentScene.audioUrl) {
          await audio.play();
        }
      } catch {
        setIsPlaying(false);
      }
    })();

    return () => {
      syncSource.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("ended", handleEnded);
      if (audio && currentScene.audioUrl) {
        audio.removeEventListener("ended", handleEnded);
      }
      video.pause();
      if (audio) audio.pause();
    };
  }, [
    isSingleVideo,
    isPlaying,
    currentSceneIndex,
    currentScene,
    scenes,
    isMuted,
    totalDuration,
    isSeeking,
  ]);

  // ===== Per-scene playback (image rotation, no video) =====
  useEffect(() => {
    if (isSingleVideo) return;
    if (!isPlaying || !currentScene) return;
    if (currentScene.videoUrl) return;

    const sceneDuration = currentScene.duration || 3;
    const images = getCurrentSceneImages(currentScene);
    const imageCount = images.length || 1;
    const timePerImage = sceneDuration / imageCount;

    const previousDuration = scenes
      .slice(0, currentSceneIndex)
      .reduce((acc, s) => acc + (s.duration || 3), 0);

    const audio = audioRef.current;

    if (currentScene.audioUrl && audio) {
      audio.src = currentScene.audioUrl;
      audio.muted = isMuted;
      audio.currentTime = 0;
      audio.load();

      // Use audio timeupdate for accurate sync
      const handleTimeUpdate = () => {
        if (isSeeking) return;
        const elapsed = audio.currentTime || 0;
        const imageIdx = Math.min(Math.floor(elapsed / timePerImage), imageCount - 1);
        setCurrentImageIndex(imageIdx);
        const pct = ((previousDuration + elapsed) / Math.max(totalDuration, 1)) * 100;
        setProgress(Math.min(pct, 100));
      };

      const handleEnded = () => {
        if (currentSceneIndex < scenes.length - 1) {
          setCurrentSceneIndex(currentSceneIndex + 1);
          setCurrentImageIndex(0);
        } else {
          setIsPlaying(false);
          setCurrentSceneIndex(0);
          setCurrentImageIndex(0);
          setProgress(0);
        }
      };

      audio.addEventListener("timeupdate", handleTimeUpdate);
      audio.addEventListener("ended", handleEnded);
      audio.play().catch(() => {});

      return () => {
        audio.removeEventListener("timeupdate", handleTimeUpdate);
        audio.removeEventListener("ended", handleEnded);
        audio.pause();
      };
    }

    // No audio — fall back to interval-based for image rotation only
    const startTime = Date.now();
    intervalRef.current = setInterval(() => {
      if (isSeeking) return;
      const elapsed = (Date.now() - startTime) / 1000;
      const imageIdx = Math.min(Math.floor(elapsed / timePerImage), imageCount - 1);
      setCurrentImageIndex(imageIdx);
      const pct = ((previousDuration + elapsed) / Math.max(totalDuration, 1)) * 100;
      setProgress(Math.min(pct, 100));

      if (elapsed >= sceneDuration) {
        if (currentSceneIndex < scenes.length - 1) {
          setCurrentSceneIndex(currentSceneIndex + 1);
          setCurrentImageIndex(0);
        } else {
          setIsPlaying(false);
          setCurrentSceneIndex(0);
          setCurrentImageIndex(0);
          setProgress(0);
        }
      }
    }, 100);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isSingleVideo, isPlaying, currentSceneIndex, currentScene, scenes, isMuted, totalDuration, isSeeking]);

  useEffect(() => {
    setCurrentImageIndex(0);
  }, [currentSceneIndex]);

  const togglePlay = () => {
    if (isSingleVideo) {
      setIsPlaying((p) => !p);
      return;
    }

    if (!isPlaying && currentSceneIndex === scenes.length - 1) {
      setCurrentSceneIndex(0);
      setCurrentImageIndex(0);
      setProgress(0);
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);

    if (isSingleVideo) {
      if (videoRef.current) videoRef.current.muted = next;
      return;
    }

    if (audioRef.current) audioRef.current.muted = next;
  };

  const handleFullscreen = () => {
    const container = document.getElementById("share-player");
    if (container?.requestFullscreen) container.requestFullscreen();
  };

  // Seekable slider handler
  const handleSeek = useCallback((values: number[]) => {
    const pct = values[0];
    setProgress(pct);

    if (isSingleVideo) {
      const video = videoRef.current;
      if (!video || !totalDuration) return;
      video.currentTime = (pct / 100) * totalDuration;
      return;
    }

    // Per-scene seek: find which scene the seek position falls in
    const targetTime = (pct / 100) * Math.max(totalDuration, 1);
    let accumulated = 0;
    for (let i = 0; i < scenes.length; i++) {
      const sceneDur = scenes[i].duration || 3;
      if (targetTime <= accumulated + sceneDur || i === scenes.length - 1) {
        const offsetInScene = targetTime - accumulated;
        setCurrentSceneIndex(i);
        setCurrentImageIndex(0);

        // Seek audio and video if present
        const audio = audioRef.current;
        const video = videoRef.current;
        if (audio && audio.src) {
          audio.currentTime = Math.max(0, offsetInScene);
        }
        if (video && video.src) {
          video.currentTime = Math.max(0, offsetInScene);
        }
        break;
      }
      accumulated += sceneDur;
    }
  }, [isSingleVideo, totalDuration, scenes]);

  const getAspectRatio = (format?: string) => {
    switch (format) {
      case "portrait":
        return "aspect-[9/16] max-h-[80vh]";
      case "square":
        return "aspect-square max-h-[80vh]";
      default:
        return "aspect-video max-w-4xl";
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !shareData) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Link Not Found</h1>
          <p className="text-muted-foreground">
            This share link is invalid, expired, or has been removed.
          </p>
          <Button asChild variant="default">
            <Link to="/">Go to MotionMax</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Hidden audio element (used only in per-scene fallback mode) */}
      <audio ref={audioRef} />

      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <ThemedLogo className="h-8 w-auto" />
          <HeaderCTA />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex flex-col items-center justify-center p-4 sm:p-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-4xl space-y-6"
        >
          {/* Title */}
          <div className="text-center">
            <h1 className="text-xl sm:text-2xl font-bold">{project?.title}</h1>
            {project?.description && (
              <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                {project.description}
              </p>
            )}
          </div>

          {/* Player */}
          <div
            id="share-player"
            className={cn("relative mx-auto overflow-hidden rounded-xl bg-black", getAspectRatio(project?.format))}
          >
            {isSingleVideo ? (
              <video
                ref={videoRef}
                src={sharedVideoUrl}
                className="absolute inset-0 w-full h-full object-contain"
                muted={isMuted}
                playsInline
                preload="metadata"
              />
            ) : currentScene?.videoUrl ? (
              <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-contain"
                muted
                playsInline
                preload="metadata"
                poster={currentImageUrl || undefined}
              />
            ) : currentImageUrl ? (
              <img
                src={currentImageUrl}
                alt={`Scene ${currentSceneIndex + 1}`}
                className="absolute inset-0 w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-white/50">No preview available</p>
              </div>
            )}

            {/* Play button overlay when paused */}
            {!isPlaying && ((isSingleVideo && !!sharedVideoUrl) || scenes.length > 0) && (
              <button
                onClick={togglePlay}
                className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
              >
                <div className="p-4 rounded-full bg-white/20 backdrop-blur-sm">
                  <Play className="h-12 w-12 text-white fill-white" />
                </div>
              </button>
            )}

            {/* Narration subtitle (only for per-scene mode) */}
            {!isSingleVideo && isPlaying && (currentScene?.narration || currentScene?.voiceover) && (
              <div className="absolute bottom-16 left-4 right-4">
                <p className="text-center text-white text-sm sm:text-base bg-black/60 px-4 py-2 rounded-lg backdrop-blur-sm">
                  {currentScene.narration || currentScene.voiceover}
                </p>
              </div>
            )}
          </div>

          {/* Controls */}
          {(isSingleVideo || scenes.length > 0) && (
            <div className="space-y-3">
              {/* Seekable progress bar */}
              <div className="px-2">
                <Slider
                  value={[progress]}
                  max={100}
                  step={0.1}
                  className="cursor-pointer"
                  onValueChange={(values) => {
                    setIsSeeking(true);
                    setProgress(values[0]);
                  }}
                  onValueCommit={(values) => {
                    handleSeek(values);
                    setIsSeeking(false);
                  }}
                />
              </div>

              <div className="flex items-center justify-center gap-4">
                <Button variant="ghost" size="icon" onClick={togglePlay} className="h-12 w-12">
                  {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                </Button>

                <Button variant="ghost" size="icon" onClick={toggleMute} className="h-10 w-10">
                  {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </Button>

                <Button variant="ghost" size="icon" onClick={handleFullscreen} className="h-10 w-10">
                  <Maximize className="h-5 w-5" />
                </Button>
              </div>
            </div>
          )}

          {/* Footer notice */}
          <p className="text-center text-xs text-muted-foreground pt-8">
            Created with MotionMax •{" "}
            <Link to="/" className="text-primary hover:underline">
              Sign up
            </Link>
          </p>
        </motion.div>
      </main>
    </div>
  );
}
