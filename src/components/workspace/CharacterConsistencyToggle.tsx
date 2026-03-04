import { useState } from "react";
import { Lock, Users, Sparkles, Crown } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSubscription } from "@/hooks/useSubscription";

interface CharacterConsistencyToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function CharacterConsistencyToggle({ enabled, onToggle }: CharacterConsistencyToggleProps) {
  const { plan, createCheckout } = useSubscription();
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const canUseFeature = plan === "professional" || plan === "enterprise";

  const handleToggleClick = () => {
    if (canUseFeature) {
      onToggle(!enabled);
    } else {
      setShowUpgradeModal(true);
    }
  };

  const handleUpgrade = async () => {
    try {
      setIsLoading(true);
      // Use the professional plan price ID
      await createCheckout("price_1SqN2U6hfVkBDzkSNCDvRyeP", "subscription");
    } catch (error) {
      console.error("Failed to create checkout:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 p-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${canUseFeature ? "bg-primary/10" : "bg-muted/50"}`}>
            {canUseFeature ? (
              <Users className="h-5 w-5 text-primary" />
            ) : (
              <Lock className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div>
            <Label className="text-sm font-medium cursor-pointer" onClick={handleToggleClick}>
              Character Consistency
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {canUseFeature 
                ? "Generate reference images for consistent characters" 
                : "Pro feature • Upgrade to unlock"
              }
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {!canUseFeature && (
            <span className="flex items-center gap-1 text-xs text-amber-500 font-medium">
              <Crown className="h-3.5 w-3.5" />
              Pro
            </span>
          )}
          <Switch
            checked={enabled && canUseFeature}
            onCheckedChange={handleToggleClick}
            disabled={!canUseFeature}
            className={!canUseFeature ? "opacity-50 cursor-not-allowed" : ""}
          />
        </div>
      </div>

      {/* Upgrade Modal */}
      <Dialog open={showUpgradeModal} onOpenChange={setShowUpgradeModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <div>
                <DialogTitle>Unlock Character Consistency</DialogTitle>
                <DialogDescription className="mt-1">
                  Professional feature
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Character Consistency uses AI to generate reference portraits for each character, 
              ensuring they look identical across all scenes in your story.
            </p>
            
            <div className="rounded-lg bg-muted/30 p-4 space-y-2">
              <h4 className="text-sm font-medium">What you get:</h4>
              <ul className="text-sm text-muted-foreground space-y-1.5">
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  AI-generated character reference portraits
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  Visual consistency across all scenes
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  Preview and regenerate characters before scenes
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  Higher quality Hypereal AI image generation
                </li>
              </ul>
            </div>
          </div>
          
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              className="flex-1" 
              onClick={() => setShowUpgradeModal(false)}
            >
              Maybe Later
            </Button>
            <Button 
              className="flex-1 gap-2"
              onClick={handleUpgrade}
              disabled={isLoading}
            >
              <Crown className="h-4 w-4" />
              {isLoading ? "Loading..." : "Upgrade to Pro"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
