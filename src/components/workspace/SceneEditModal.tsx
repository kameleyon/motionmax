import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Save, RefreshCw, Loader2, Wand2, Volume2, Image as ImageIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Scene } from "@/hooks/useGenerationPipeline";

interface SceneEditModalProps {
  scene: Scene;
  sceneIndex: number;
  format: "landscape" | "portrait" | "square";
  onClose: () => void;
  onRegenerateAudio: (sceneIndex: number, newVoiceover: string) => Promise<void>;
  onRegenerateImage: (sceneIndex: number, imageModification: string, imageIndex?: number) => Promise<void>;
  isRegenerating: boolean;
  regeneratingType: "audio" | "image" | null;
}

export function SceneEditModal({
  scene,
  sceneIndex,
  format,
  onClose,
  onRegenerateAudio,
  onRegenerateImage,
  isRegenerating,
  regeneratingType,
}: SceneEditModalProps) {
  const [voiceover, setVoiceover] = useState(scene.voiceover);
  const [imageModification, setImageModification] = useState("");
  const [hasScriptChanges, setHasScriptChanges] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const aspectClass =
    format === "portrait" ? "aspect-[9/16]" : format === "square" ? "aspect-square" : "aspect-video";

  const currentImages = scene.imageUrls?.length ? scene.imageUrls : scene.imageUrl ? [scene.imageUrl] : [];
  const hasMultipleImages = currentImages.length > 1;

  const handleVoiceoverChange = (value: string) => {
    setVoiceover(value);
    setHasScriptChanges(value !== scene.voiceover);
  };

  const handleSaveScript = async () => {
    if (!hasScriptChanges) return;
    await onRegenerateAudio(sceneIndex, voiceover);
    setHasScriptChanges(false);
  };

  const handleModifyImage = async () => {
    if (!imageModification.trim()) return;
    await onRegenerateImage(sceneIndex, imageModification, selectedImageIndex);
    // Keep the text so user can make iterative edits
  };

  const handleRegenerateNewImage = async () => {
    await onRegenerateImage(sceneIndex, "", selectedImageIndex);
  };

  const goToPrevImage = () => {
    setSelectedImageIndex((prev) => (prev > 0 ? prev - 1 : currentImages.length - 1));
  };

  const goToNextImage = () => {
    setSelectedImageIndex((prev) => (prev < currentImages.length - 1 ? prev + 1 : 0));
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
              {/* Two Column Layout: Image Left, Edit Options Right */}
              <div className="grid md:grid-cols-2 gap-6">
                {/* Left Column - Image Preview with Selector */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ImageIcon className="h-5 w-5 text-muted-foreground" />
                      <Label className="text-base font-medium">
                        {hasMultipleImages 
                          ? `Image ${selectedImageIndex + 1} of ${currentImages.length}` 
                          : "Current Image"}
                      </Label>
                    </div>
                  </div>

                  {/* Image Thumbnails for Multiple Images - NOW ON TOP */}
                  {hasMultipleImages && (
                    <div className="flex gap-2 overflow-x-auto pb-2">
                      {currentImages.map((imgUrl, idx) => (
                        <button
                          key={idx}
                          onClick={() => setSelectedImageIndex(idx)}
                          disabled={isRegenerating}
                          className={cn(
                            "flex-shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-all",
                            selectedImageIndex === idx 
                              ? "border-primary ring-2 ring-primary/30" 
                              : "border-transparent hover:border-muted-foreground/30",
                            isRegenerating && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          <img
                            src={imgUrl}
                            alt={`Thumbnail ${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Main Image Preview with Navigation */}
                  <div className={cn("relative rounded-lg overflow-hidden bg-muted/50", aspectClass)}>
                    {currentImages[selectedImageIndex] ? (
                      <img
                        src={currentImages[selectedImageIndex]}
                        alt={`Scene ${scene.number} - Image ${selectedImageIndex + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        No image
                      </div>
                    )}

                    {/* Navigation Arrows for Multiple Images */}
                    {hasMultipleImages && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={goToPrevImage}
                          disabled={isRegenerating}
                          className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white h-8 w-8 rounded-full"
                        >
                          <ChevronLeft className="h-5 w-5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={goToNextImage}
                          disabled={isRegenerating}
                          className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 hover:bg-black/70 text-white h-8 w-8 rounded-full"
                        >
                          <ChevronRight className="h-5 w-5" />
                        </Button>
                      </>
                    )}

                    {isRegenerating && regeneratingType === "image" && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-2" />
                          <p className="text-sm text-white">Editing image...</p>
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
                      <Label className="text-base font-medium">
                        Edit {hasMultipleImages ? `Image ${selectedImageIndex + 1}` : "Image"}
                      </Label>
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
                        onClick={handleModifyImage}
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
                            Editing...
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

                  {/* Visual Prompt hidden - uncomment if needed for debugging
                  <div className="space-y-2">
                    <Label className="text-sm text-muted-foreground">Visual Prompt (reference)</Label>
                    <p className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg line-clamp-4">
                      {scene.visualPrompt}
                    </p>
                  </div>
                  */}
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
