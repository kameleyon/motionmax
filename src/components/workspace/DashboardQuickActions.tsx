import { useNavigate } from "react-router-dom";
import { Video, Clapperboard, Wallpaper, Film } from "lucide-react";

const QUICK_ACTIONS = [
  { mode: "doc2video",    title: "Explainers",     description: "Paste text, get a narrated video",         icon: Video },
  { mode: "smartflow",    title: "Smart Flow",      description: "Upload data, get visual slides",           icon: Wallpaper },
  { mode: "cinematic",    title: "Cinematic",       description: "Direct each scene of your film",           icon: Film },
];

export function DashboardQuickActions() {
  const navigate = useNavigate();

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Start Creating</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {QUICK_ACTIONS.map(({ mode, title, description, icon: ActionIcon }) => (
          <button
            key={mode}
            onClick={() => navigate(`/app/create?mode=${mode}`)}
            className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm p-4 text-left hover:border-primary transition-colors shadow-sm group"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 mb-3">
              <ActionIcon className="h-5 w-5 text-primary" />
            </div>
            <p className="type-h4 text-foreground group-hover:text-primary transition-colors">
              {title}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
