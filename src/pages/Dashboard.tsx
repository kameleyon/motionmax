import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { 
  Lightbulb,
  Clapperboard,
  Wallpaper,
  Menu,
  Video,
  Film,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { format } from "date-fns";

// Import background images
import dashboardBgDark from "@/assets/dashboard/dashboard-bg-dark.png";
import dashboardBgLight from "@/assets/dashboard/dashboard-bg-light.png";
import defaultThumbnail from "@/assets/dashboard/default-thumbnail.png";

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

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { plan, creditsBalance: subCreditsBalance } = useSubscription();
  const [currentTip, setCurrentTip] = useState(0);
  const [greetingIndex] = useState(() => Math.floor(Math.random() * GREETINGS.length));

  // Rotate tips
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTip((prev) => (prev + 1) % TIPS.length);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  // Fetch credits
  const { data: credits } = useQuery({
    queryKey: ["user-credits", user?.id],
    queryFn: async () => {
      if (!user?.id) return { balance: 0 };
      
      const { data } = await supabase
        .from("user_credits")
        .select("credits_balance")
        .eq("user_id", user.id)
        .single();
      
      const balance = data?.credits_balance ?? 0;
      return { balance };
    },
    enabled: !!user?.id,
  });

  // Fetch display name from profiles table
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

  // Fetch recent projects - single lightweight query using permanent thumbnail_url
  const { data: recentProjects = [], isLoading: isLoadingProjects } = useQuery({
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
      
      return (projects || []).map(p => ({
        ...p,
        thumbnailUrl: p.thumbnail_url || null,
      }));
    },
    enabled: !!user?.id,
    staleTime: 30000,
  });

  const creditsBalance = credits?.balance ?? 0;
  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'User';

  const formatCredits = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}K`;
    if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return n.toString();
  };

  const getCreateMode = (projectType?: string | null) => {
    switch (projectType) {
      case "storytelling":
        return "storytelling";
      case "smartflow":
        return "smartflow";
      case "cinematic":
        return "cinematic";
      default:
        return "doc2video";
    }
  };

  const getProjectIcon = (projectType: string) => {
    switch (projectType) {
      case "storytelling":
        return Clapperboard;
      case "smartflow":
        return Wallpaper;
      case "cinematic":
        return Film;
      default:
        return Video;
    }
  };

  return (
    <div className="flex h-screen flex-col bg-background overflow-hidden relative">
      {/* Background Image - more subtle in light mode */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-15 dark:opacity-0 pointer-events-none"
        style={{ backgroundImage: `url(${dashboardBgLight})` }}
      />
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-0 dark:opacity-40 pointer-events-none"
        style={{ backgroundImage: `url(${dashboardBgDark})` }}
      />
      
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

      {/* Main Content */}
      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-10 space-y-8">
          
          {/* Welcome Section */}
          <div className="space-y-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
              {GREETINGS[greetingIndex].greeting}, {displayName}
            </h1>
            <p className="text-muted-foreground">{GREETINGS[greetingIndex].suffix}</p>
          </div>

          {/* Credits Remaining + Did You Know Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Credits Remaining Card */}
            <div className="rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm p-5 shadow-sm">
              <div className="flex items-center gap-5">
                 <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-primary/30 bg-primary/10 shrink-0">
                   <span className={`font-bold text-primary ${creditsBalance >= 100000 ? 'text-[11px]' : creditsBalance >= 10000 ? 'text-xs' : creditsBalance >= 1000 ? 'text-sm' : 'text-lg'}`}>
                     {creditsBalance.toLocaleString()}
                   </span>
                </div>
                <div>
                  <h3 className="font-semibold text-foreground mb-1">Credits Remaining</h3>
                  <p className="text-sm text-primary font-medium">{creditsBalance} credits available</p>
                  <p className="text-xs text-muted-foreground">
                    {plan === "free" ? "Free plan" : `${plan.charAt(0).toUpperCase() + plan.slice(1)} plan`}
                  </p>
                </div>
              </div>
            </div>

            {/* Did You Know Card */}
            <div className="rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                  <Lightbulb className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-foreground mb-2">Did You Know?</h3>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={currentTip}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="text-sm text-muted-foreground leading-relaxed"
                    >
                      Tip: {TIPS[currentTip]}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </div>

          {/* Recent Projects Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">Recent Projects</h2>
              <Button 
                variant="link" 
                className="text-brand-primary dark:text-primary font-semibold p-0 h-auto hover:opacity-80"
                onClick={() => navigate("/projects")}
              >
                View All
              </Button>
            </div>

            {isLoadingProjects ? (
              /* Skeleton loader while projects are loading */
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="shrink-0 w-[200px] rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm overflow-hidden shadow-sm">
                    <Skeleton className="h-24 w-full" />
                    <div className="p-3 space-y-2">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : recentProjects.length === 0 ? (
              <div className="rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm p-8 text-center shadow-sm">
                <p className="text-muted-foreground mb-4">No projects yet</p>
                <Button onClick={() => navigate("/app/create")} className="gap-2">
                  <Video className="h-4 w-4" />
                  Create Your First Project
                </Button>
              </div>
            ) : (
              <Carousel
                opts={{
                  align: "start",
                  slidesToScroll: 1,
                }}
                className="w-full"
              >
                <CarouselContent className="-ml-4">
                  {recentProjects.map((project) => {
                    const ProjectIcon = getProjectIcon(project.project_type);
                    return (
                      <CarouselItem key={project.id} className="pl-4 basis-[200px] sm:basis-[220px]">
                        <div
                          onClick={() => {
                            const mode = getCreateMode(project.project_type);
                            navigate(`/app/create?mode=${mode}&project=${project.id}`);
                          }}
                          className="rounded-xl border border-primary/75 bg-white/90 dark:bg-card/80 backdrop-blur-sm overflow-hidden cursor-pointer hover:border-primary transition-colors shadow-sm group"
                        >
                          {/* Thumbnail area */}
                          <div className="h-24 bg-gradient-to-br from-primary/30 via-primary/15 to-muted/20 flex items-center justify-center relative overflow-hidden">
                            <img 
                              src={project.thumbnailUrl || defaultThumbnail} 
                              alt={project.title}
                              className="absolute inset-0 w-full h-full object-cover"
                            />
                            {/* Category icon overlay */}
                            <div className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/50 backdrop-blur-sm z-10">
                              <ProjectIcon className="h-4 w-4 text-white" />
                            </div>
                          </div>
                          {/* Info area */}
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
                    <CarouselPrevious className="hidden sm:flex -left-3 border-primary/75" />
                    <CarouselNext className="hidden sm:flex -right-3 border-primary/75" />
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
