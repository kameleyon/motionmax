import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, Wand2, Volume2, Film, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface CinematicScene {
  number: number;
  voiceover: string;
  visualPrompt: string;
  videoUrl?: string;
  audioUrl?: string;
  duration: number;
}

interface CinematicEditModalProps {
  scene: CinematicScene;
  sceneIndex: number;
  format: "landscape" | "portrait" | "square";
  onClose: () => void;
  onRegenerateAudio: (sceneIndex: number, newVoiceover: string) => Promise<void>;
  onRegenerateVideo: (sceneIndex: number) => Promise<void>;
  onApplyImageEdit: (sceneIndex: number, imageModification: string) => Promise<void>;
  onRegenerateImage: (sceneIndex: number) => Promise<void>;
  isRegenerating: boolean;
  regeneratingType: "audio" | "video" | "image" | null;
}

export function CinematicEditModal({
  scene,
  sceneIndex,
  format,
  onClose,
  onRegenerateAudio,
  onRegenerateVideo,
  onApplyImageEdit,
  onRegenerateImage,
  isRegenerating,
  regeneratingType,
}: CinematicEditModalProps) {
  const [voiceover, setVoiceover] = useState(scene.voiceover);
  const [imageModification, setImageModification] = useState("");
  const [hasScriptChanges, setHasScriptChanges] = useState(false);

  const aspectClass =
    format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video";

  const handleVoiceoverChange = (value: string) => {
    setVoiceover(value);
    setHasScriptChanges(value !== scene.voiceover);
  };

  const handleSaveScript = async () => {
    if (!hasScriptChanges) return;
    await onRegenerateAudio(sceneIndex, voiceover);
    setHasScriptChanges(false);
  };

  const handleApplyEdit = async () => {
    if (!imageModification.trim()) return;
    await onApplyImageEdit(sceneIndex, imageModification);
  };

  const handleRegenerateNewImage = async () => {
    await onRegenerateImage(sceneIndex);
  };

  const handleRegenerateVideoOnly = async () => {
    await onRegenerateVideo(sceneIndex);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget && !isRegenerating) onClose();
        }}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="w-full max-w-4xl max-h-[90vh] flex flex-col"
        >
          <Card className="bg-card border-border overflow-hidden rounded-xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-lg font-semibold text-foreground">
                Edit Scene {scene.number}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                disabled={isRegenerating}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            <div 
              className="p-6 overflow-y-auto scrollbar-thin"
              style={{
                scrollbarWidth: 'thin',
                scrollbarColor: 'hsl(var(--brand-accent)) transparent',
              }}
            >
              {/* Two Column Layout: Video Left, Edit Options Right */}
              <div className="grid md:grid-cols-2 gap-6">
                {/* Left Column - Video Preview */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Film className="h-5 w-5 text-muted-foreground" />
                    <Label className="text-base font-medium">Current Video</Label>
                  </div>

                  {/* Video Preview */}
                  <div className={cn("relative rounded-lg overflow-hidden bg-muted/50", aspectClass)}>
                    {scene.videoUrl ? (
                      <video
                        src={scene.videoUrl}
                        className="w-full h-full object-cover"
                        muted
                        playsInline
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        <Film className="h-12 w-12 opacity-50" />
                      </div>
                    )}

                    {isRegenerating && (regeneratingType === "video" || regeneratingType === "image") && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
                          <p className="text-sm text-white">
                            {regeneratingType === "image" ? "Generating image & video..." : "Regenerating video..."}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right Column - Edit Options */}
                <div className="space-y-6">
                  {/* Image Edit Section */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Wand2 className="h-5 w-5 text-muted-foreground" />
                      <Label className="text-base font-medium">Edit Image</Label>
                    </div>
                    <Textarea
                      value={imageModification}
                      onChange={(e) => setImageModification(e.target.value.slice(0, 5000))}
                      placeholder="e.g., Make the background blue, add a sunset, change the expression to happy..."
                      className="min-h-[100px] resize-none"
                      disabled={isRegenerating}
                      maxLength={5000}
                    />
                    <p className="text-xs text-muted-foreground text-right">
                      {imageModification.length}/5000
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={handleApplyEdit}
                        disabled={!imageModification.trim() || isRegenerating}
                        className={cn(
                          "flex-1 gap-2",
                          imageModification.trim()
                            ? "bg-primary hover:bg-primary/90 text-primary-foreground"
                            : "bg-primary/60 text-primary-foreground"
                        )}
                      >
                        {isRegenerating && regeneratingType === "image" && imageModification.trim() ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Applying...
                          </>
                        ) : (
                          <>
                            <Wand2 className="h-4 w-4" />
                            Apply Edit
                          </>
                        )}
                      </Button>
                    </div>
                    <Button
                      onClick={handleRegenerateNewImage}
                      disabled={isRegenerating}
                      variant="outline"
                      className="w-full gap-2"
                    >
                      {isRegenerating && regeneratingType === "image" && !imageModification.trim() ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Regenerating...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4" />
                          Regenerate New Image
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Video Regeneration Section */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Film className="h-5 w-5 text-muted-foreground" />
                      <Label className="text-base font-medium">Regenerate Video</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Regenerate the video clip from the current visual prompt (without changing the image).
                    </p>
                    <Button
                      onClick={handleRegenerateVideoOnly}
                      disabled={isRegenerating}
                      variant="outline"
                      className="w-full gap-2"
                    >
                      {isRegenerating && regeneratingType === "video" ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Regenerating Video...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4" />
                          Regenerate Video Only
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Script / Voiceover Section */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Volume2 className="h-5 w-5 text-muted-foreground" />
                      <Label className="text-base font-medium">Script / Voiceover</Label>
                    </div>
                    <Textarea
                      value={voiceover}
                      onChange={(e) => handleVoiceoverChange(e.target.value)}
                      className="min-h-[100px] resize-none"
                      placeholder="Enter the voiceover text..."
                      disabled={isRegenerating}
                    />

                    {/* Current Audio Player */}
                    {scene.audioUrl && (
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Current Audio</Label>
                        <audio
                          key={scene.audioUrl}
                          controls
                          preload="none"
                          src={scene.audioUrl}
                          className="w-full h-8"
                        />
                      </div>
                    )}

                    <Button
                      onClick={handleSaveScript}
                      disabled={!hasScriptChanges || isRegenerating}
                      className={cn(
                        "w-full gap-2",
                        hasScriptChanges 
                          ? "bg-primary hover:bg-primary/90 text-primary-foreground" 
                          : "bg-primary/60 text-primary-foreground"
                      )}
                    >
                      {isRegenerating && regeneratingType === "audio" ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Regenerating Audio...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4" />
                          {hasScriptChanges ? "Save & Regenerate Audio" : "No Changes"}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 p-4 border-t border-border bg-muted/30">
              <Button
                variant="outline"
                onClick={onClose}
                disabled={isRegenerating}
              >
                Close
              </Button>
            </div>
          </Card>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
