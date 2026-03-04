import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemedLogo } from "@/components/ThemedLogo";

interface WorkspaceLayoutProps {
  /** Optional elements rendered in the right side of the header (e.g. generating indicator) */
  headerActions?: ReactNode;
  /** The main workspace content */
  children: ReactNode;
}

export function WorkspaceLayout({ headerActions, children }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background overflow-hidden">
      {/* Top Bar */}
      <header className="grid h-14 sm:h-16 grid-cols-3 items-center border-b border-border/30 bg-background/80 px-4 sm:px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3 sm:gap-4 justify-start">
          <SidebarTrigger className="lg:hidden">
            <Menu className="h-5 w-5 text-muted-foreground" />
          </SidebarTrigger>
          <div className="hidden lg:flex items-center">
            <ThemedLogo className="h-10 w-auto" />
          </div>
        </div>

        {/* Mobile centered logo */}
        <div className="flex justify-center lg:hidden">
          <ThemedLogo className="h-10 w-auto" />
        </div>

        <div className="flex items-center justify-end gap-3">
          {headerActions}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4 sm:py-12">
          {children}
        </div>
      </main>
    </div>
  );
}
