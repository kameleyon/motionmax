import { useRef, useCallback } from "react";
import { Users, ImagePlus, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CharacterDescriptionInputProps {
  value: string;
  onChange: (value: string) => void;
  images?: string[];
  onImagesChange?: (images: string[]) => void;
}

const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4MB
const MAX_IMAGES = 10;

export function CharacterDescriptionInput({ value, onChange, images = [], onImagesChange }: CharacterDescriptionInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((files: FileList | File[]) => {
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      toast.error(`Maximum ${MAX_IMAGES} reference images`);
      return;
    }

    const toProcess = Array.from(files).slice(0, remaining);
    let processed = 0;
    const newImages: string[] = [];

    toProcess.forEach(file => {
      if (!file.type.startsWith("image/")) {
        toast.error(`${file.name} is not an image`);
        return;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error(`${file.name} exceeds 4MB`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        newImages.push(reader.result as string);
        processed++;
        if (processed === toProcess.length) {
          onImagesChange?.([...images, ...newImages]);
        }
      };
      reader.readAsDataURL(file);
    });
  }, [images, onImagesChange]);

  const removeImage = useCallback((index: number) => {
    onImagesChange?.(images.filter((_, i) => i !== index));
  }, [images, onImagesChange]);

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Character Appearance
      </label>
      <Textarea
        placeholder="Describe or upload images of your characters — e.g., Main character is a Black woman with natural hair in her 30s, the villain is a tall older man with gray beard..."
        className="min-h-[80px] resize-none rounded-xl border-border/50 bg-transparent text-sm placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />

      {/* Image upload */}
      {onImagesChange && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="relative">
                  <img
                    src={img}
                    alt={`Character ref ${i + 1}`}
                    className="h-20 w-20 rounded-lg object-cover border border-border/50"
                  />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-sm hover:bg-destructive/90"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {images.length < MAX_IMAGES && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              className="gap-2 text-xs"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              {images.length === 0 ? "Upload Reference Images" : "Add More"}
            </Button>
          )}
        </>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
        <Users className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Describe or upload reference images of your characters (up to {MAX_IMAGES}). The AI will match their appearance across all scenes.
        </span>
      </div>
    </div>
  );
}
