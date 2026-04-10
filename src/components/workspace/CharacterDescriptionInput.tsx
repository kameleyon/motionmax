import { useRef, useCallback } from "react";
import { Users, ImagePlus, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CharacterDescriptionInputProps {
  value: string;
  onChange: (value: string) => void;
  imageUrl?: string | null;
  onImageChange?: (base64: string | null) => void;
}

const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4MB

export function CharacterDescriptionInput({ value, onChange, imageUrl, onImageChange }: CharacterDescriptionInputProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast.error("Image must be under 4MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      onImageChange?.(reader.result as string);
    };
    reader.readAsDataURL(file);
  }, [onImageChange]);

  return (
    <div className="space-y-3">
      <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Character Appearance
      </label>
      <Textarea
        placeholder="Describe or upload an image of your characters — e.g., Main character is a Black woman with natural hair in her 30s, tall athletic build..."
        className="min-h-[80px] resize-none rounded-xl border-border/50 bg-transparent text-sm placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-primary"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />

      {/* Image upload */}
      {onImageChange && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />

          {imageUrl ? (
            <div className="relative inline-block">
              <img
                src={imageUrl}
                alt="Character reference"
                className="h-20 w-20 rounded-lg object-cover border border-border/50"
              />
              <button
                onClick={() => onImageChange(null)}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-sm hover:bg-destructive/90"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              className="gap-2 text-xs"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              Upload Reference Image
            </Button>
          )}
        </>
      )}

      <div className="flex items-start gap-2 text-xs text-muted-foreground/70">
        <Users className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Describe or upload a reference image of your characters. The AI will match their appearance across all scenes.
        </span>
      </div>
    </div>
  );
}
