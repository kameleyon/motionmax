import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AnimatedOutlet } from "@/components/layout/AnimatedOutlet";
import { WorkspaceErrorBoundary } from "@/components/workspace/WorkspaceErrorBoundary";
import { SubscriptionRenewalModal } from "@/components/workspace/SubscriptionRenewalModal";

/**
 * Shared authenticated app shell used by simple sidebar routes (/app, /app/create, /pricing).
 * Provides SidebarProvider + AppSidebar + WorkspaceErrorBoundary via React Router's AnimatedOutlet.
 */
export function AppShell() {
  return (
    <SidebarProvider defaultOpen={true}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm">
        Skip to content
      </a>
      <div className="flex min-h-screen w-full overflow-hidden">
        <AppSidebar />
        <main id="main-content" role="main" className="flex-1 min-w-0 overflow-hidden">
          <WorkspaceErrorBoundary>
            <AnimatedOutlet />
          </WorkspaceErrorBoundary>
        </main>
      </div>
      <SubscriptionRenewalModal />
    </SidebarProvider>
  );
}
