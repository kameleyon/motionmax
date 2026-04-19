import { cn } from "@/lib/utils";
import { ThemedLogo } from "@/components/ThemedLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SidebarTrigger } from "@/components/ui/sidebar";

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
      <div className="hidden lg:block" />

      {/* Right: actions + theme toggle */}
      <div className="flex items-center justify-end gap-2">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
