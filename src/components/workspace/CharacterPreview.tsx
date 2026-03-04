import { RefreshCw, User, Check, X } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export interface CharacterData {
  name: string;
  description: string;
  referenceImageUrl: string;
}

interface CharacterPreviewProps {
  characters: CharacterData[];
  isLoading?: boolean;
  onRegenerateCharacter?: (index: number) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  regeneratingIndex?: number | null;
}

export function CharacterPreview({
  characters,
  isLoading = false,
  onRegenerateCharacter,
  onConfirm,
  onCancel,
  regeneratingIndex,
}: CharacterPreviewProps) {
  if (isLoading) {
    return (
      <div className="space-y-4 rounded-2xl border border-border/50 bg-card/50 p-6 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <User className="h-5 w-5 text-primary animate-pulse" />
          </div>
          <div>
            <h3 className="text-sm font-medium">Generating Characters...</h3>
            <p className="text-xs text-muted-foreground">Creating reference portraits for your story</p>
          </div>
        </div>
        
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-square rounded-lg" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (characters.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4 rounded-2xl border border-primary/30 bg-card/50 p-6 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-medium">Character References</h3>
            <p className="text-xs text-muted-foreground">
              These will be used for visual consistency across scenes
            </p>
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {characters.map((character, index) => (
          <motion.div
            key={character.name}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: index * 0.1 }}
            className="group relative space-y-2"
          >
            <div className="relative aspect-square overflow-hidden rounded-lg border border-border/50 bg-muted/30">
              {regeneratingIndex === index ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/80">
                  <RefreshCw className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <>
                  <img
                    src={character.referenceImageUrl}
                    alt={character.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  {onRegenerateCharacter && (
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute bottom-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => onRegenerateCharacter(index)}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                </>
              )}
            </div>
            <div>
              <h4 className="text-sm font-medium truncate">{character.name}</h4>
              <p className="text-xs text-muted-foreground line-clamp-2">{character.description}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {(onConfirm || onCancel) && (
        <div className="flex gap-3 pt-2">
          {onCancel && (
            <Button variant="outline" className="flex-1 gap-2" onClick={onCancel}>
              <X className="h-4 w-4" />
              Cancel
            </Button>
          )}
          {onConfirm && (
            <Button className="flex-1 gap-2" onClick={onConfirm}>
              <Check className="h-4 w-4" />
              Continue with these characters
            </Button>
          )}
        </div>
      )}
    </motion.div>
  );
}
