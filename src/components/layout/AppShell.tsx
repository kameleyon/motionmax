import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { AnimatedOutlet } from "@/components/layout/AnimatedOutlet";
import { WorkspaceErrorBoundary } from "@/components/workspace/WorkspaceErrorBoundary";
import { SubscriptionRenewalModal } from "@/components/workspace/SubscriptionRenewalModal";
import { useSidebarState } from "@/hooks/useSidebarState";
import BetaRebuildBanner from "@/components/layout/BetaRebuildBanner";

export function AppShell() {
  const { isOpen, setIsOpen } = useSidebarState();

  return (
    <SidebarProvider defaultOpen={isOpen} onOpenChange={setIsOpen}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm">
        Skip to content
      </a>
      {/* Outer wrapper switched to flex-col so BetaRebuildBanner can
          take its own full-width row above the sidebar+main row. The
          gold strip is impossible to miss and every legacy page
          inherits it for free — no per-page wiring needed. */}
      <div className="flex flex-col min-h-screen w-full overflow-hidden">
        <BetaRebuildBanner />
        <div className="flex flex-1 min-h-0 w-full overflow-hidden">
          <AppSidebar />
          <main id="main-content" role="main" className="flex-1 min-w-0 overflow-hidden">
            <WorkspaceErrorBoundary>
              <AnimatedOutlet />
            </WorkspaceErrorBoundary>
          </main>
        </div>
      </div>
      <SubscriptionRenewalModal />
    </SidebarProvider>
  );
}
