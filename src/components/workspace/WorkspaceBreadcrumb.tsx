import { ChevronRight, Home } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface WorkspaceBreadcrumbProps {
  mode: string;
  projectTitle?: string;
}

const MODE_LABELS: Record<string, string> = {
  doc2video: "Explainers",
  storytelling: "Visual Stories",
  smartflow: "Smart Flow",
  cinematic: "Cinematic",
};

export function WorkspaceBreadcrumb({ mode, projectTitle }: WorkspaceBreadcrumbProps) {
  const navigate = useNavigate();
  const modeLabel = MODE_LABELS[mode] || mode;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
      <button
        onClick={() => navigate("/app")}
        className="flex items-center gap-1 hover:text-foreground transition-colors"
      >
        <Home className="h-3 w-3" />
        <span>Dashboard</span>
      </button>
      <ChevronRight className="h-3 w-3" />
      <button
        onClick={() => navigate(`/app/create?mode=${mode}`)}
        className="hover:text-foreground transition-colors"
      >
        {modeLabel}
      </button>
      {projectTitle && (
        <>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground truncate max-w-[200px]">{projectTitle}</span>
        </>
      )}
    </nav>
  );
}
