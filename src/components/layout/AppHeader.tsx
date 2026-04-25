import { cn } from "@/lib/utils";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

interface AppHeaderProps {
  /** Extra controls rendered to the right of the ThemeToggle */
  actions?: React.ReactNode;
  className?: string;
}

export function AppHeader({ actions, className }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 grid h-14 sm:h-16 grid-cols-3 items-center",
        "border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm",
        className
      )}
    >
      {/* Left: sidebar trigger + logo (desktop) */}
      <div className="flex items-center justify-start gap-2">
        <SidebarTrigger />
        <ThemedLogo className="hidden lg:block h-10 w-auto" />
      </div>

      {/* Center: logo (mobile) */}
      <div className="flex justify-center lg:hidden">
        <ThemedLogo className="h-10 w-auto" />
      </div>
      {/* Center banner — soft invitation to switch to the new
          dashboard while we're still in beta. Lives in the empty
          middle grid column so it sits dead-centre under the topbar
          without colliding with the left/right sections. Lg+ only
          (no room for it on tablet, and the existing "New Dashboard"
          pill on the right already covers smaller viewports). */}
      <div className="hidden lg:flex justify-center">
        <Link
          to="/dashboard-new"
          className="inline-flex items-center gap-2 rounded-full border border-[#14C8CC]/30 bg-[#14C8CC]/10 px-3.5 py-1 text-[11.5px] font-medium text-[#14C8CC] hover:bg-[#14C8CC]/15 transition-colors whitespace-nowrap"
          title="Try the new dashboard"
        >
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="font-mono text-[9.5px] tracking-[0.16em] uppercase rounded bg-[#E4C875]/15 text-[#E4C875] px-1.5 py-px">
            Beta
          </span>
          <span>We're rebuilding MotionMax — try the new dashboard →</span>
        </Link>
      </div>

      {/* Right: actions + "new dashboard" preview link + theme toggle */}
      <div className="flex items-center justify-end gap-2">
        {actions}
        {/* Preview link to the new dashboard while it's under construction.
            Sits next to the ThemeToggle (moon/sun icon). Remove this
            button once DashboardLayout graduates to /app. */}
        <Link
          to="/dashboard-new"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
          title="Preview the new dashboard"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">New Dashboard</span>
        </Link>
        <ThemeToggle />
      </div>
    </header>
  );
}
