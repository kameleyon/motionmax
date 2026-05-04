import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Clock, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { getProjectTypeMeta } from "@/lib/projectUtils";

interface ActiveJob {
  id: string;
  status: string;
  progress: number;
  project_id: string | null;
  project_title: string | null;
  project_type: string | null;
  created_at: string;
}

export function GenerationQueueStatus() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: activeJobs = [] } = useQuery<ActiveJob[]>({
    queryKey: ["active-generations", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      // Fetch in-progress generations
      const { data, error } = await supabase
        .from("generations")
        .select("id, status, progress, project_id, created_at")
        .eq("user_id", user.id)
        .in("status", ["pending", "processing", "generating"])
        .order("created_at", { ascending: false })
        .limit(5);

      if (error || !data?.length) return [];

      // Fetch project titles for context
      const projectIds = data.filter(g => g.project_id).map(g => g.project_id!);
      const projectMap: Record<string, { title: string; project_type: string | null }> = {};

      if (projectIds.length > 0) {
        const { data: projects } = await supabase
          .from("projects")
          .select("id, title, project_type")
          .in("id", projectIds);

        if (projects) {
          for (const p of projects) {
            projectMap[p.id] = { title: p.title, project_type: p.project_type };
          }
        }
      }

      return data.map(g => ({
        id: g.id,
        status: g.status,
        progress: g.progress ?? 0,
        project_id: g.project_id,
        project_title: g.project_id ? projectMap[g.project_id]?.title ?? null : null,
        project_type: g.project_id ? projectMap[g.project_id]?.project_type ?? null : null,
        created_at: g.created_at,
      }));
    },
    enabled: !!user?.id,
    refetchInterval: 10_000, // Poll every 10s while active
    staleTime: 5_000,
  });

  if (activeJobs.length === 0) return null;

  const getElapsedMinutes = (createdAt: string) => {
    const elapsed = Date.now() - new Date(createdAt).getTime();
    return Math.max(1, Math.round(elapsed / 60_000));
  };

  const getModeLabel = (projectType: string | null) => getProjectTypeMeta(projectType).label;
  // getCreateMode is no longer needed: project clicks now route to
  // /app/editor/:id and the editor figures out the mode itself.
  // const getCreateMode  = (projectType: string | null) => getProjectTypeMeta(projectType).mode;

  return (
    <div className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm p-5 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <h3 className="font-semibold text-foreground text-sm">
          Processing ({activeJobs.length})
        </h3>
      </div>

      <ul className="space-y-2">
        {activeJobs.map((job) => {
          const elapsed = getElapsedMinutes(job.created_at);
          return (
            <li
              key={job.id}
              className="flex items-center gap-3 rounded-lg bg-muted/30 p-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => {
                if (job.project_id) {
                  navigate(`/app/editor/${job.project_id}`);
                }
              }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {job.project_title || "Untitled"}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{getModeLabel(job.project_type)}</span>
                  <span>·</span>
                  <Clock className="h-3 w-3" />
                  <span>{elapsed} min</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-16 bg-muted/30 rounded-full h-1.5 relative overflow-hidden">
                  <div
                    className="bg-gradient-to-r from-primary to-primary/70 h-1.5 rounded-full transition-all duration-500 relative overflow-hidden"
                    style={{ width: `${Math.min(job.progress, 100)}%` }}
                  >
                    {/* Subtle shimmer animation */}
                    {job.progress < 100 && (
                      <div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"
                        style={{
                          animation: "shimmer 2s linear infinite",
                        }}
                      />
                    )}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground w-8 text-right">
                  {job.progress}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
