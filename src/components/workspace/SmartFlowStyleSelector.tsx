import { Wand2, Pencil, Users, Camera, Palette, Laugh, PenTool, Baby, ChevronLeft, ChevronRight, Upload, X, GraduationCap, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useRef, useState, useEffect } from "react";
import { uploadStyleReference } from "@/lib/uploadStyleReference";

// Import style preview images
import minimalistPreview from "@/assets/styles/minimalist-preview.png";
import doodlePreview from "@/assets/styles/doodle-preview.png";
import stickPreview from "@/assets/styles/stick-preview.png";
import realisticPreview from "@/assets/styles/realistic-preview.png";
import storybookPreview from "@/assets/styles/painterly-preview.png";
import caricaturePreview from "@/assets/styles/caricature-preview.png";
import sketchPreview from "@/assets/styles/sketch-preview.png";
import crayonPreview from "@/assets/styles/crayon-preview.png";
import chalkboardPreview from "@/assets/styles/chalkboard-preview.png";
import customPreview from "@/assets/styles/custom-preview.png";

/**
 * SmartFlow-specific style selector with 10 styles.
 * Includes chalkboard (educational focus), excludes anime/moody/3d-pixar/claymation
 * which are available in the main StyleSelector used by other workspaces.
 */
export type SmartFlowStyle = "minimalist" | "doodle" | "stick" | "realistic" | "storybook" | "caricature" | "sketch" | "crayon" | "chalkboard" | "custom";

interface SmartFlowStyleSelectorProps {
  selected: SmartFlowStyle;
  onSelect: (style: SmartFlowStyle) => void;
  customStyle?: string;
  onCustomStyleChange?: (value: string) => void;
  customStyleImage?: string | null;
  onCustomStyleImageChange?: (image: string | null) => void;
  brandMarkEnabled?: boolean;
  brandMarkText?: string;
  onBrandMarkEnabledChange?: (enabled: boolean) => void;
  onBrandMarkTextChange?: (text: string) => void;
}

const styles: { id: SmartFlowStyle; label: string; icon: React.ElementType; preview: string }[] = [
  { id: "minimalist", label: "Minimalist", icon: Wand2, preview: minimalistPreview },
  { id: "doodle", label: "Urban Doodle", icon: Pencil, preview: doodlePreview },
  { id: "stick", label: "Stick Figure", icon: Users, preview: stickPreview },
  { id: "realistic", label: "Realistic", icon: Camera, preview: realisticPreview },
  { id: "storybook", label: "Storybook", icon: Palette, preview: storybookPreview },
  { id: "caricature", label: "Caricature", icon: Laugh, preview: caricaturePreview },
  { id: "crayon", label: "Crayon", icon: Baby, preview: crayonPreview },
  { id: "sketch", label: "Papercut 3D", icon: PenTool, preview: sketchPreview },
  { id: "chalkboard", label: "Chalkboard", icon: GraduationCap, preview: chalkboardPreview },
  { id: "custom", label: "Custom", icon: Wand2, preview: customPreview },
];

export function SmartFlowStyleSelector({ 
  selected, 
  onSelect,
  customStyle = "",
  onCustomStyleChange,
  customStyleImage,
  onCustomStyleImageChange,
  brandMarkEnabled = false,
  brandMarkText = "",
  onBrandMarkEnabledChange,
  onBrandMarkTextChange
}: SmartFlowStyleSelectorProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);
  const [uploading, setUploading] = useState(false);

  const checkScrollPosition = () => {
    const container = scrollContainerRef.current;
    if (container) {
      setCanScrollLeft(container.scrollLeft > 0);
      setCanScrollRight(
        container.scrollLeft < container.scrollWidth - container.clientWidth - 10
      );
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      checkScrollPosition();
      container.addEventListener("scroll", checkScrollPosition);
      return () => container.removeEventListener("scroll", checkScrollPosition);
    }
  }, []);

  const scroll = (direction: "left" | "right") => {
    const container = scrollContainerRef.current;
    if (container) {
      const scrollAmount = 200;
      container.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
    }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) return;
    
    setUploading(true);
    try {
      const url = await uploadStyleReference(file);
      onCustomStyleImageChange?.(url);
    } catch (err) {
      console.error("Style reference upload error:", err);
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveImage = () => {
    onCustomStyleImageChange?.(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">Choose visual style</h3>
      
      <div className="relative">
        {/* Left Arrow */}
        <button
          onClick={() => scroll("left")}
          className={cn(
            "absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 border border-border/50 shadow-sm backdrop-blur-sm transition-all",
            canScrollLeft 
              ? "opacity-100 hover:bg-muted" 
              : "opacity-0 pointer-events-none"
          )}
          aria-label="Scroll left"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {/* Right Arrow */}
        <button
          onClick={() => scroll("right")}
          className={cn(
            "absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 border border-border/50 shadow-sm backdrop-blur-sm transition-all",
            canScrollRight 
              ? "opacity-100 hover:bg-muted" 
              : "opacity-0 pointer-events-none"
          )}
          aria-label="Scroll right"
        >
          <ChevronRight className="h-4 w-4" />
        </button>

        {/* Carousel Container */}
        <div
          ref={scrollContainerRef}
          className="flex gap-2 sm:gap-3 overflow-x-auto scrollbar-hide px-1 py-1"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {styles.map((style) => (
            <motion.button
              key={style.id}
              onClick={() => onSelect(style.id)}
              className={cn(
                "group relative flex-shrink-0 w-[100px] sm:w-[120px] overflow-hidden rounded-lg sm:rounded-xl border-2 transition-all bg-muted",
                selected === style.id
                  ? "border-primary shadow-sm shadow-primary/20"
                  : "border-border hover:border-border"
              )}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              {/* Preview Image */}
              <div className="aspect-[4/3] overflow-hidden bg-muted">
                <img
                  src={style.preview}
                  alt={style.label}
                  className={cn(
                    "h-full w-full object-cover transition-transform duration-300",
                    "group-hover:scale-105"
                  )}
                />
              </div>
              
              {/* Label */}
              <div className={cn(
                "px-1.5 sm:px-2 py-1.5 sm:py-2 text-center transition-colors",
                selected === style.id 
                  ? "bg-primary/10" 
                  : "bg-muted/50"
              )}>
                <span className={cn(
                  "text-[10px] sm:text-xs font-medium",
                  selected === style.id ? "text-primary" : "text-muted-foreground"
                )}>
                  {style.label}
                </span>
              </div>

              {/* Selection Indicator */}
              {selected === style.id && (
                <motion.div
                  layoutId="smartflow-style-indicator"
                  className="absolute inset-0 rounded-xl ring-2 ring-primary ring-offset-4 ring-offset-background shadow-sm"
                  initial={false}
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
            </motion.button>
          ))}
        </div>

        {/* Scroll Indicator Dots */}
        <div className="flex justify-center gap-1 mt-3">
          {Array.from({ length: Math.ceil(styles.length / 4) }).map((_, index) => (
            <div
              key={index}
              className={cn(
                "h-1 rounded-full transition-all",
                index === 0 && !canScrollLeft
                  ? "w-4 bg-primary"
                  : index === Math.ceil(styles.length / 4) - 1 && !canScrollRight
                  ? "w-4 bg-primary"
                  : "w-1 bg-muted-foreground/30"
              )}
            />
          ))}
        </div>
      </div>

      {/* Custom Style Input */}
      {selected === "custom" && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
          <div className="pt-2 space-y-3">
            <Input
              placeholder="Describe your custom style..."
              value={customStyle}
              onChange={(e) => onCustomStyleChange?.(e.target.value)}
              className="rounded-xl border-border/50 bg-muted/30 focus:bg-background"
            />
            
            {/* Style Reference Image Upload */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Or upload a style reference image
              </Label>
              
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              
              {customStyleImage ? (
                <div className="relative inline-block">
                  <div className="relative rounded-lg overflow-hidden border border-border/50 bg-muted/30">
                    <img
                      src={customStyleImage}
                      alt="Style reference"
                      className="h-24 w-auto object-cover"
                    />
                    <button
                      onClick={handleRemoveImage}
                      className="absolute top-1 right-1 p-1 rounded-full bg-background/80 hover:bg-background border border-border/50 transition-colors"
                      aria-label="Remove image"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-1">
                    AI will mimic this visual style
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="gap-2 rounded-lg border-dashed border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {uploading ? "Uploading..." : "Upload reference image"}
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Brand Mark Option */}
      <div className="pt-4 border-t border-border/30 px-1">
        <div className="flex items-center gap-3">
          <Checkbox 
            id="smartflow-brand-mark" 
            checked={brandMarkEnabled}
            onCheckedChange={(checked) => onBrandMarkEnabledChange?.(checked === true)}
          />
          <Label 
            htmlFor="smartflow-brand-mark" 
            className="text-sm font-medium text-muted-foreground cursor-pointer"
          >
            Your brand mark
          </Label>
        </div>
        
        {brandMarkEnabled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="pt-3 px-1">
              <Input
                placeholder="Company name or copyright text..."
                value={brandMarkText}
                onChange={(e) => onBrandMarkTextChange?.(e.target.value)}
                className="rounded-xl border-border/50 bg-muted/30 focus:bg-background text-sm w-full"
                maxLength={50}
              />
              <p className="text-xs text-muted-foreground/60 mt-1.5">
                Appears bottom-left on all generated images as a signature
              </p>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
