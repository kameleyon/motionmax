import { useState, type ReactNode } from 'react';
import Sidebar from './Sidebar';
import NotificationsPopover from './NotificationsPopover';
import HelpPopover from './HelpPopover';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import motionmaxLogo from '@/assets/motionmax-logo.webp';

/** Shared app shell — sidebar + topbar + scrollable main column.
 *  Both DashboardLayout (home) and the All-projects page mount this so
 *  the navigation chrome stays identical between routes; pages just
 *  pass their content as children + customise the breadcrumb label. */
export default function AppShell({
  breadcrumb = 'Studio',
  children,
}: {
  breadcrumb?: string;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-[100dvh] relative bg-[#0A0D0F] text-[#ECEAE4] font-sans overflow-hidden">
      {/* Skip-to-content for keyboard / screen-reader users so they bypass
          the sidebar nav. WCAG 2.1 AA bypass-blocks. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:bg-[#14C8CC] focus:text-[#0A0D0F] focus:rounded-md focus:font-semibold focus:text-[13px]"
      >
        Skip to main content
      </a>

      <div
        className="fixed inset-0 pointer-events-none z-overlay opacity-5 mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.2 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      <Sidebar />

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 md:hidden [&>button]:text-[#ECEAE4]"
          style={{ height: '100dvh' }}
        >
          <div
            className="h-full overflow-y-auto [&_aside]:flex [&_aside]:w-full [&_aside]:border-r-0 [&_aside]:h-auto [&_aside]:min-h-full [&_aside]:overflow-visible [&_aside_nav]:overflow-visible"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      <main className="flex flex-col overflow-hidden min-w-0 flex-1">
        <div className="flex items-center gap-2 px-3 sm:px-4 md:px-7 py-3 border-b border-white/10 bg-[#0A0D0F]/70 backdrop-blur-md shrink-0 h-[64px]">
          <button
            onClick={() => setDrawerOpen(true)}
            className="md:hidden w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
            aria-label="Open sidebar"
            title="Menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <a
            href="/dashboard-new"
            className="md:hidden flex items-center gap-1.5 shrink-0"
            style={{ textDecoration: 'none' }}
            aria-label="MotionMax home"
          >
            <img src={motionmaxLogo} alt="MotionMax" className="h-6 w-auto" />
            <span className="font-serif text-[16px] font-medium tracking-tight leading-none">
              <span className="text-[#14C8CC]">Motion</span>
              <span className="text-[#E4C875]">Max</span>
            </span>
          </a>
          <div className="hidden md:flex items-center gap-2 text-[13px] text-[#8A9198]">
            <span>Workspace</span>
            <span className="text-[#5A6268]">/</span>
            <span className="text-[#ECEAE4]">{breadcrumb}</span>
          </div>
          <div className="flex-1" />
          <NotificationsPopover />
          <HelpPopover />
        </div>

        <div id="main-content" className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10">
          {children}
        </div>
      </main>
    </div>
  );
}
