import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb, Menu, Video, Film, Clapperboard, Wallpaper, AlertCircle, FolderOpen, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DashboardQuickActions } from "@/components/workspace/DashboardQuickActions";
import { OnboardingChecklist } from "@/components/dashboard/OnboardingChecklist";
import { LowCreditWarning } from "@/components/dashboard/LowCreditWarning";
import { GenerationQueueStatus } from "@/components/dashboard/GenerationQueueStatus";
import { normalizeProjectType } from "@/lib/projectUtils";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { format } from "date-fns";

import defaultThumbnail from "@/assets/dashboard/default-thumbnail.png";

const TIPS_INTERVAL_MS = 8000;
const ANIMATION_DURATION_MS = 300;

const TIPS = [
  "Use 'Presenter Focus' to control which subjects appear in your visuals",
  "Try the Anime style for dynamic, expressive storytelling",
  "Short videos (< 1 min) work great for social media content",
  "Add 'Character Appearance' descriptions for consistent visuals",
  "The 'Stick Figure' style is perfect for educational explainers",
  "Use brand marks to add your logo to generated images",
];

const GREETINGS = [
  { greeting: "Hey", suffix: "Ready to create?" },
  { greeting: "Welcome back", suffix: "Let's make something great." },
  { greeting: "Good to see you", suffix: "What are we building today?" },
  { greeting: "Hi there", suffix: "Your canvas awaits." },
  { greeting: "Hello", suffix: "Time to bring ideas to life." },
  { greeting: "Welcome", suffix: "Let's get creative." },
];

const getProjectIcon = (projectType?: string | null) => {
  switch (normalizeProjectType(projectType)) {
    case "storytelling": return Clapperboard;
    case "smartflow":    return Wallpaper;
    case "cinematic":   return Film;
    default:            return Video;
  }
};

const getCreateMode = (projectType?: string | null) => {
  switch (normalizeProjectType(projectType)) {
    case "storytelling": return "storytelling";
    case "smartflow":    return "smartflow";
    case "cinematic":   return "cinematic";
    default:            return "doc2video";
  }
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { plan } = useSubscription();
  const [currentTip, setCurrentTip] = useState(0);
  const [greetingIndex] = useState(() => Math.floor(Math.random() * GREETINGS.length));

  // Rotate tips — pauses when tab is backgrounded to avoid wasted background work
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        setCurrentTip((prev) => (prev + 1) % TIPS.length);
      }, TIPS_INTERVAL_MS + ANIMATION_DURATION_MS);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        if (timer) { clearInterval(timer); timer = null; }
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const { data: credits, isError: isCreditsError } = useQuery({
    queryKey: ["user-credits", user?.id],
    queryFn: async () => {
      if (!user?.id) return { balance: 0 };
      const { data } = await supabase
        .from("user_credits")
        .select("credits_balance")
        .eq("user_id", user.id)
        .single();
      return { balance: data?.credits_balance ?? 0 };
    },
    enabled: !!user?.id,
  });

  const { data: profile } = useQuery({
    queryKey: ["user-profile", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", user.id)
        .single();
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: recentProjects = [], isLoading: isLoadingProjects, isError: isProjectsError } = useQuery({
    queryKey: ["dashboard-recent", user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data: projects, error } = await supabase
        .from("projects")
        .select("id, title, created_at, updated_at, project_type, style, thumbnail_url")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      if (!projects?.length) return [];

      // Only query generations.scenes for projects missing a thumbnail_url
      const missingIds = projects.filter(p => !p.thumbnail_url).map(p => p.id);
      const thumbnailMap: Record<string, string | null> = {};

      if (missingIds.length > 0) {
        const { data: generations } = await supabase
          .from("generations")
          .select("project_id, scenes")
          .in("project_id", missingIds)
          .eq("status", "complete")
          .order("created_at", { ascending: false });

        if (generations) {
          for (const gen of generations) {
            if (thumbnailMap[gen.project_id] !== undefined) continue;
            const scenes = gen.scenes as any[];
            if (Array.isArray(scenes) && scenes.length > 0) {
              const first = scenes[0];
              thumbnailMap[gen.project_id] =
                first?.imageUrl ||
                first?.image_url ||
                (Array.isArray(first?.imageUrls) ? first.imageUrls[0] : null) ||
                null;
            }
          }
        }
      }

      return projects.map(p => ({
        ...p,
        thumbnailUrl: p.thumbnail_url ?? thumbnailMap[p.id] ?? null,
      }));
    },
    enabled: !!user?.id,
    staleTime: 30000,
  });

  const creditsBalance = credits?.balance ?? 0;
  const displayName = profile?.display_name || user?.email?.split("@")[0] || "User";

  return (
    <div className="flex h-screen flex-col bg-background overflow-hidden relative">
      {/* Header */}
      <header className="relative z-10 flex h-14 sm:h-16 items-center justify-between border-b border-primary/20 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 sm:gap-4">
          <SidebarTrigger className="lg:hidden">
            <Menu className="h-5 w-5 text-muted-foreground" />
          </SidebarTrigger>
          <ThemedLogo className="h-8 lg:h-10 w-auto" />
        </div>
        <ThemeToggle />
      </header>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-10 space-y-8">

          {/* Welcome */}
          <div className="space-y-1">
            <h1 className="type-h1 text-foreground">
              {GREETINGS[greetingIndex].greeting}, {displayName}
            </h1>
            <p className="text-muted-foreground">{GREETINGS[greetingIndex].suffix}</p>
          </div>

          {/* Stats Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Credits Card */}
            <div className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm p-5 shadow-sm">
              <div className="flex items-center gap-5">
                <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-primary/30 bg-primary/10 shrink-0">
                  {isCreditsError ? (
                    <AlertCircle className="h-6 w-6 text-destructive" />
                  ) : (
                    <span className={`font-semibold text-primary ${creditsBalance >= 100000 ? "text-xs" : creditsBalance >= 10000 ? "text-xs" : creditsBalance >= 1000 ? "text-sm" : "text-lg"}`}>
                      {creditsBalance.toLocaleString()}
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="type-h4 text-foreground mb-1">Credits Remaining</h3>
                  {isCreditsError ? (
                    <p className="text-sm text-destructive">Couldn't load balance</p>
                  ) : (
                    <p className="text-sm text-primary font-medium">{creditsBalance} credits available</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {plan === "free" ? "Free plan" : `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan`}
                  </p>
                </div>
              </div>
            </div>

            {/* Did You Know */}
            <div className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                  <Lightbulb className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h3 className="type-h4 text-foreground mb-2">Did You Know?</h3>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={currentTip}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: ANIMATION_DURATION_MS / 1000 }}
                      className="text-sm text-muted-foreground leading-relaxed"
                    >
                      Tip: {TIPS[currentTip]}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>

          {/* Low Credit Warning */}
          <LowCreditWarning balance={creditsBalance} />

          {/* Generation Queue Status */}
          <GenerationQueueStatus />

          {/* Quick Actions */}
          <DashboardQuickActions />

          {/* Onboarding for new users */}
          {!isLoadingProjects && recentProjects.length === 0 && (
            <>
              <OnboardingChecklist hasProjects={false} />

              {/* First-time sample prompt */}
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="type-h4 text-foreground">Try it now — one click</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      See what MotionMax can do. We'll generate a short explainer video from a sample topic.
                    </p>
                  </div>
                </div>
                <Button
                  className="w-full sm:w-auto gap-2"
                  onClick={() => navigate("/app/create?mode=doc2video&template=sample")}
                >
                  <Sparkles className="h-4 w-4" />
                  Create a Sample Video
                </Button>
              </div>
            </>
          )}

          {/* Recent Projects */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="type-h3 text-foreground">Recent Projects</h2>
              <Button
                variant="link"
                className="text-brand-primary dark:text-primary font-semibold p-0 h-auto hover:opacity-80"
                onClick={() => navigate("/projects")}
              >
                View All
              </Button>
            </div>

            {isProjectsError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
                <AlertCircle className="h-5 w-5 text-destructive mx-auto mb-2" />
                <p className="text-sm text-destructive font-medium">Couldn't load recent projects</p>
                <p className="text-xs text-muted-foreground mt-1">Check your connection and refresh the page.</p>
              </div>
            ) : isLoadingProjects ? (
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="shrink-0 w-[200px] rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden shadow-sm">
                    <Skeleton className="h-24 w-full" />
                    <div className="p-3 space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm shadow-sm">
                <EmptyState
                  icon={FolderOpen}
                  title="Your studio is empty — not for long"
                  description="Create your first video in under 5 minutes. Paste any text, pick a style, and let AI handle the rest."
                  actionLabel="Create Your First Video"
                  onAction={() => navigate("/app/create")}
                  className="py-8"
                />
              </div>
            ) : (
              <Carousel opts={{ align: "start", slidesToScroll: 1 }} className="w-full">
                <CarouselContent className="-ml-4">
                  {recentProjects.map((project) => {
                    const ProjectIcon = getProjectIcon(project.project_type);
                    return (
                      <CarouselItem key={project.id} className="pl-4 basis-[200px] sm:basis-[220px]">
                        <div
                          onClick={() => navigate(`/app/create?mode=${getCreateMode(project.project_type)}&project=${project.id}`)}
                          className="rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden cursor-pointer hover:border-primary transition-colors shadow-sm group"
                        >
                          <div className="h-24 bg-gradient-to-br from-primary/30 via-primary/15 to-muted/20 flex items-center justify-center relative overflow-hidden">
                            <img
                              src={project.thumbnailUrl || defaultThumbnail}
                              alt={project.title}
                              loading="lazy"
                              decoding="async"
                              className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                              onError={(e) => {
                                const img = e.target as HTMLImageElement;
                                img.onerror = null;
                                img.src = defaultThumbnail;
                              }}
                            />
                            {/* Hover overlay with play icon */}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors duration-300 flex items-center justify-center">
                              <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 p-2 rounded-full bg-white/20 backdrop-blur-sm">
                                <Film className="h-5 w-5 text-white" />
                              </div>
                            </div>
                            <div className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 backdrop-blur-sm z-10">
                              <ProjectIcon className="h-4 w-4 text-white" />
                            </div>
                          </div>
                          <div className="p-3">
                            <p className="font-medium text-sm text-foreground truncate group-hover:text-primary transition-colors">
                              {project.title}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Last edited {format(new Date(project.updated_at), "MMM d, yyyy")}
                            </p>
                          </div>
                        </div>
                      </CarouselItem>
                    );
                  })}
                </CarouselContent>
                {recentProjects.length > 3 && (
                  <>
                    <CarouselPrevious className="hidden sm:flex -left-3 border-border/50" />
                    <CarouselNext className="hidden sm:flex -right-3 border-border/50" />
                  </>
                )}
              </Carousel>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
