import { motion, AnimatePresence } from "framer-motion";
import { X, RotateCcw, Image as ImageIcon, Volume2, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSceneVersions, type SceneVersion } from "@/hooks/useSceneVersions";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { callPhase } from "@/hooks/generation/callPhase";
import { useToast } from "@/hooks/use-toast";

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
  const { toast } = useToast();

  const handleRestoreVersion = async (version: SceneVersion) => {
    setRestoringVersion(version.id);

    try {
      // Call undo multiple times to reach the desired version
      const currentVersionNumber = versions[0]?.version_number || 0;
      const targetVersionNumber = version.version_number;
      const undoCount = currentVersionNumber - targetVersionNumber;

      if (undoCount <= 0) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Cannot restore to a future version",
        });
        return;
      }

      // Undo multiple times
      for (let i = 0; i < undoCount; i++) {
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

      toast({
        title: "Version Restored",
        description: `Scene ${sceneName} restored to version ${version.version_number}`,
      });

      await refetch();
      onVersionRestored();
    } catch (error) {
      console.error("Failed to restore version:", error);
      toast({
        variant: "destructive",
        title: "Restore Failed",
        description: error instanceof Error ? error.message : "Failed to restore version",
      });
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
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
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
          <Card className="bg-card border-border overflow-hidden rounded-xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Version History - {sceneName}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  {versions.length} {versions.length === 1 ? "version" : "versions"} available
                </p>
              </div>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-5 w-5" />
              </Button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto scrollbar-thin flex-1">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                </div>
              ) : versions.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <p>No version history available</p>
                  <p className="text-xs mt-1">Versions are created when you regenerate scenes</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {versions.map((version, index) => {
                    const imageUrl =
                      version.image_url ||
                      (version.image_urls && version.image_urls.length > 0 ? version.image_urls[0] : null);
                    const isLatest = index === 0;

                    return (
                      <motion.div
                        key={version.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                      >
                        <Card className={`p-4 hover:border-primary/50 transition-all cursor-pointer ${selectedVersion?.id === version.id ? "border-primary" : ""}`}
                          onClick={() => setSelectedVersion(version)}
                        >
                          <div className="flex gap-4">
                            {/* Thumbnail */}
                            {imageUrl && (
                              <div className="flex-shrink-0 w-32 h-20 rounded-lg overflow-hidden bg-muted">
                                <img
                                  src={imageUrl}
                                  alt={`Version ${version.version_number}`}
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            )}

                            {/* Details */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-2">
                                <h3 className="text-sm font-medium">
                                  Version {version.version_number}
                                </h3>
                                {isLatest && (
                                  <Badge variant="outline" className="text-xs">
                                    Current
                                  </Badge>
                                )}
                                <Badge className={`text-xs ${getChangeTypeColor(version.change_type)}`}>
                                  {version.change_type === "audio" && <Volume2 className="h-3 w-3 mr-1" />}
                                  {version.change_type === "image" && <ImageIcon className="h-3 w-3 mr-1" />}
                                  {version.change_type}
                                </Badge>
                              </div>

                              {version.voiceover && (
                                <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                                  {version.voiceover}
                                </p>
                              )}

                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <div className="flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {formatDistanceToNow(new Date(version.created_at), { addSuffix: true })}
                                </div>
                                {version.duration && (
                                  <div>{version.duration}s</div>
                                )}
                              </div>
                            </div>

                            {/* Restore Button */}
                            {!isLatest && (
                              <div className="flex items-center">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRestoreVersion(version);
                                  }}
                                  disabled={restoringVersion !== null}
                                  className="gap-2"
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
