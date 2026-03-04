import { motion, AnimatePresence } from "framer-motion";
import { Star, MoreVertical, Eye, Pencil, Share2, Download, Trash2, Video, Clapperboard, Wallpaper, Film, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import defaultThumbnail from "@/assets/dashboard/default-thumbnail.png";

interface Project {
  id: string;
  title: string;
  description: string | null;
  format: string;
  style: string;
  status: string;
  is_favorite: boolean;
  created_at: string;
  updated_at: string;
  project_type?: string;
  thumbnailUrl?: string | null;
}

interface ProjectsGridViewProps {
  projects: Project[];
  onView: (project: Project) => void;
  onRename: (project: Project) => void;
  onDelete: (project: Project) => void;
  onShare: (project: Project) => void;
  onDownload: (project: Project) => void;
  onToggleFavorite: (project: Project, e?: React.MouseEvent) => void;
  downloadingProjectId?: string | null;
}

const getProjectIcon = (projectType?: string) => {
  switch (projectType) {
    case "storytelling":
      return Clapperboard;
    case "smartflow":
    case "smart-flow":
      return Wallpaper;
    case "cinematic":
      return Film;
    default:
      return Video;
  }
};

const getAspectRatio = (format: string) => {
  switch (format) {
    case "portrait":
      return "aspect-[9/16]";
    case "square":
      return "aspect-square";
    default: // landscape
      return "aspect-video";
  }
};

const formatTimestamp = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return format(d, "MMM d");
};

export function ProjectsGridView({
  projects,
  onView,
  onRename,
  onDelete,
  onShare,
  onDownload,
  onToggleFavorite,
  downloadingProjectId,
}: ProjectsGridViewProps) {
  return (
    <div className="columns-2 md:columns-3 lg:columns-4 gap-4 space-y-4">
      <AnimatePresence>
        {projects.map((project, index) => {
          const ProjectIcon = getProjectIcon(project.project_type);
          return (
            <motion.div
              key={project.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: index * 0.03, duration: 0.3 }}
              className="break-inside-avoid mb-4"
            >
              <div
                onClick={() => onView(project)}
                className="group relative rounded-xl border border-border/60 bg-card/50 overflow-hidden cursor-pointer hover:border-primary/50 hover:shadow-lg transition-all duration-300"
              >
                {/* Thumbnail */}
                <div className={cn("relative w-full overflow-hidden", getAspectRatio(project.format))}>
                  <img
                    src={project.thumbnailUrl || defaultThumbnail}
                    alt={project.title}
                    className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  
                  {/* Overlay on hover */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-300" />
                  
                  {/* Category icon */}
                  <div className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 backdrop-blur-sm">
                    <ProjectIcon className="h-3.5 w-3.5 text-white" />
                  </div>
                  
                  {/* Favorite button */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 left-2 h-7 w-7 bg-black/30 hover:bg-black/50 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(project, e);
                    }}
                  >
                    <Star
                      className={cn(
                        "h-4 w-4",
                        project.is_favorite
                          ? "fill-primary text-primary"
                          : "text-white"
                      )}
                    />
                  </Button>
                  
                  {/* Actions menu */}
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 bg-black/30 hover:bg-black/50 backdrop-blur-sm">
                          <MoreVertical className="h-4 w-4 text-white" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => onView(project)}>
                          <Eye className="mr-2 h-4 w-4" />
                          Open
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onRename(project)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onShare(project)}>
                          <Share2 className="mr-2 h-4 w-4" />
                          Share
                        </DropdownMenuItem>
                        <DropdownMenuItem 
                          onClick={() => onDownload(project)}
                          disabled={downloadingProjectId === project.id}
                        >
                          {downloadingProjectId === project.id ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="mr-2 h-4 w-4" />
                          )}
                          {downloadingProjectId === project.id ? "Downloading..." : "Download Video"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => onDelete(project)}
                          className="text-muted-foreground focus:text-foreground"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                
                {/* Info */}
                <div className="p-3">
                  <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">
                    {project.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatTimestamp(project.updated_at)} • {project.format}
                  </p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}