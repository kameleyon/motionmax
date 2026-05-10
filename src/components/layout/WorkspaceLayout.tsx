import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemedLogo } from "@/components/ThemedLogo";
import { WorkspaceBreadcrumb } from "@/components/workspace/WorkspaceBreadcrumb";

interface WorkspaceLayoutProps {
  /** Optional elements rendered in the right side of the header (e.g. generating indicator) */
  headerActions?: ReactNode;
  /** Workspace mode for breadcrumb */
  mode?: string;
  /** Project title for breadcrumb (when editing an existing project) */
  projectTitle?: string;
  /** The main workspace content */
  children: ReactNode;
}

export function WorkspaceLayout({ headerActions, mode, projectTitle, children }: WorkspaceLayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-background overflow-hidden">
      {/* F-A11Y-021 — skip-link. Keyboard-only users (and switch/SR users
          who navigate by Tab) otherwise have to traverse the entire
          header chrome on every page load before reaching the main
          content. Mirrors the pattern from Auth.tsx (Wave 4). Hidden
          off-screen by sr-only until focused, then reveals at the top
          of the viewport. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-background focus:text-foreground"
      >
        Skip to main content
      </a>

      {/* Top Bar */}
      <header className="grid h-14 sm:h-16 grid-cols-3 gap-2 sm:gap-4 items-center border-b border-border/30 bg-background/80 px-2 min-[375px]:px-4 sm:px-6 backdrop-blur-sm">
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

      {/* Main Content — id="main-content" is the skip-link target. */}
      <main id="main-content" className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-4xl px-3 sm:px-6 py-4 sm:py-12 pb-24">
          {mode && <WorkspaceBreadcrumb mode={mode} projectTitle={projectTitle} />}
          {children}
        </div>
      </main>
    </div>
  );
}
