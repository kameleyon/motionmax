import { createScopedLogger } from "@/lib/logger";
import { motion, AnimatePresence } from "framer-motion";
import { X, RotateCcw, Image as ImageIcon, Volume2, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSceneVersions, type SceneVersion } from "@/hooks/useSceneVersions";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { callPhase } from "@/hooks/generation/callPhase";
import { toast } from "sonner";

const log = createScopedLogger("SceneVersionHistory");

interface SceneVersionHistoryProps {
  generationId: string;
  projectId: string;
  sceneIndex: number;
  sceneName: string;
  onClose: () => void;
  onVersionRestored: () => void;
}

export function SceneVersionHistory({
  generationId,
  projectId,
  sceneIndex,
  sceneName,
  onClose,
  onVersionRestored,
}: SceneVersionHistoryProps) {
  const { data: versions = [], isLoading, refetch } = useSceneVersions(generationId, sceneIndex);
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<SceneVersion | null>(null);

  const handleRestoreVersion = async (version: SceneVersion, versionIndex: number) => {
    setRestoringVersion(version.id);

    try {
      // versions are sorted newest-first; index 0 is current.
      // Undo `versionIndex` times to reach the target.
      if (versionIndex <= 0) {
        toast.error("Error", { description: "Cannot restore to the current version" });
        return;
      }

      for (let i = 0; i < versionIndex; i++) {
        await callPhase(
          {
            phase: "undo",
            generationId,
            projectId,
            sceneIndex,
          },
          30 * 1000
        );
      }

      toast.success("Version Restored", {
        description: `Scene ${sceneName} restored to a previous version`,
      });

      await refetch();
      onVersionRestored();
    } catch (error) {
      log.error("Failed to restore version:", error);
      toast.error("Restore Failed", { description: error instanceof Error ? error.message : "Failed to restore version" });
    } finally {
      setRestoringVersion(null);
    }
  };

  const getChangeTypeColor = (changeType: string) => {
    switch (changeType) {
      case "audio":
        return "bg-blue-500/10 text-blue-500 border-blue-500/20";
      case "image":
        return "bg-purple-500/10 text-purple-500 border-purple-500/20";
      case "both":
        return "bg-primary/10 text-primary border-primary/20";
      case "initial":
        return "bg-muted text-muted-foreground border-border";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="w-full max-w-5xl max-h-[90vh] flex flex-col"
        >
          <Card className="bg-[#0A0D0F] border-white/10 overflow-hidden rounded-xl flex flex-col max-h-[90vh] text-[#ECEAE4]">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 p-3 sm:p-4 border-b border-white/10 shrink-0 bg-[#10151A]">
              <div className="min-w-0">
                <h2 className="font-serif text-base sm:text-lg font-medium text-[#ECEAE4] truncate">
                  Version History — {sceneName}
                </h2>
                <p className="text-[11px] sm:text-xs text-[#8A9198] mt-0.5 sm:mt-1">
                  {versions.length} {versions.length === 1 ? "version" : "versions"} available
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close"
                onClick={onClose}
                className="text-[#8A9198] hover:bg-white/5 hover:text-[#ECEAE4]"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>

            {/* Content */}
            <div className="p-3 sm:p-6 overflow-y-auto scrollbar-thin flex-1 bg-[#0A0D0F]">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-[#14C8CC]" />
                </div>
              ) : versions.length === 0 ? (
                <div className="text-center py-12 text-[#8A9198]">
                  <p>No version history available</p>
                  <p className="text-xs mt-1 text-[#5A6268]">Versions are created when you regenerate scenes</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {versions.map((version, index) => {
                    const imageUrl =
                      version.image_url ||
                      (version.image_urls && version.image_urls.length > 0 ? version.image_urls[0] : null);
                    const isLatest = index === 0;
                    const displayNumber = versions.length - index;

                    return (
                      <motion.div
                        key={version.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <Card
                          className={`p-3 sm:p-4 bg-[#10151A] border transition-all cursor-pointer ${
                            selectedVersion?.id === version.id
                              ? "border-[#14C8CC]"
                              : "border-white/5 hover:border-[#14C8CC]/50"
                          }`}
                          onClick={() => setSelectedVersion(version)}
                        >
                          {/* Mobile: thumbnail + details sit in a flex row,
                              Restore button moves to its OWN row below the
                              whole card. Desktop: classic three-column row
                              (thumb + details + restore). */}
                          <div className="flex gap-3 sm:gap-4">
                            {/* Thumbnail — smaller on mobile so the text
                                column actually has room to breathe. */}
                            {imageUrl && (
                              <div className="flex-shrink-0 w-20 h-14 sm:w-32 sm:h-20 rounded-lg overflow-hidden bg-[#050709] border border-white/5">
                                <img
                                  src={imageUrl}
                                  alt={`Version ${displayNumber}`}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            )}

                            {/* Details — flex-wrap on the badge row so
                                "Version N" + "Current" + "image" don't push
                                each other onto separate lines and force
                                weird wrapping of the version number. */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1.5 sm:mb-2 flex-wrap">
                                <h3 className="text-sm font-medium text-[#ECEAE4] whitespace-nowrap">
                                  Version {displayNumber}
                                </h3>
                                {isLatest && (
                                  <Badge variant="outline" className="text-[10px] sm:text-xs border-white/10 text-[#8A9198]">
                                    Current
                                  </Badge>
                                )}
                                <Badge className={`text-[10px] sm:text-xs ${getChangeTypeColor(version.change_type)}`}>
                                  {version.change_type === "audio" && <Volume2 className="h-3 w-3 mr-1" />}
                                  {version.change_type === "image" && <ImageIcon className="h-3 w-3 mr-1" />}
                                  {version.change_type}
                                </Badge>
                              </div>

                              {version.voiceover && (
                                <p className="text-[11px] sm:text-xs text-[#8A9198] line-clamp-2 mb-1.5 sm:mb-2">
                                  {version.voiceover}
                                </p>
                              )}

                              <div className="flex items-center gap-3 sm:gap-4 text-[11px] sm:text-xs text-[#5A6268] flex-wrap">
                                <div className="flex items-center gap-1 whitespace-nowrap">
                                  <Clock className="h-3 w-3 shrink-0" />
                                  {formatDistanceToNow(new Date(version.created_at), { addSuffix: true })}
                                </div>
                                {version.duration && (
                                  <div className="whitespace-nowrap">{version.duration}s</div>
                                )}
                              </div>
                            </div>

                            {/* Restore Button — hidden on mobile (moves
                                below the row); shown inline on sm+. */}
                            {!isLatest && (
                              <div className="hidden sm:flex items-center">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRestoreVersion(version, index);
                                  }}
                                  disabled={restoringVersion !== null}
                                  className="gap-2 border-white/10 bg-[#0A0D0F] text-[#ECEAE4] hover:bg-white/5 hover:text-[#ECEAE4]"
                                >
                                  {restoringVersion === version.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <RotateCcw className="h-4 w-4" />
                                  )}
                                  Restore
                                </Button>
                              </div>
                            )}
                          </div>

                          {/* Mobile-only Restore row — full-width button
                              under the row so it doesn't fight the text
                              column for space. Hidden on sm+. */}
                          {!isLatest && (
                            <div className="sm:hidden mt-3 pt-3 border-t border-white/5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRestoreVersion(version, index);
                                }}
                                disabled={restoringVersion !== null}
                                className="w-full gap-2 border-white/10 bg-[#0A0D0F] text-[#ECEAE4] hover:bg-white/5 hover:text-[#ECEAE4]"
                              >
                                {restoringVersion === version.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-4 w-4" />
                                )}
                                Restore
                              </Button>
                            </div>
                          )}
                        </Card>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
