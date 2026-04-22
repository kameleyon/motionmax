import { useState } from 'react';
import Sidebar from './Sidebar';
import Hero from './Hero';
import ProjectsGallery from './ProjectsGallery';
import RightRail from './RightRail';
import NotificationsPopover from './NotificationsPopover';
import HelpPopover from './HelpPopover';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import CreateModeTiles from './CreateModeTiles';

/** Responsive dashboard shell.
 *
 *  Desktop (≥ 1024px): fixed 252px sidebar + main.
 *  Tablet  (768–1023): sidebar still visible but main shrinks; right
 *                      rail hides (below xl) so we don't crunch content.
 *  Mobile  (< 768px):  sidebar is hidden off-canvas behind a drawer that
 *                      opens from the topbar hamburger. */
export default function DashboardLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen relative bg-[#0A0D0F] text-[#ECEAE4] font-sans overflow-hidden">
      {/* filmic grain — pointer-events-none so it never eats clicks */}
      <div
        className="fixed inset-0 pointer-events-none z-[200] opacity-5 mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.2 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      {/* Desktop/tablet sidebar — visible at md+ (Sidebar itself uses
          `hidden md:flex`). Phones get the drawer below. */}
      <Sidebar />

      {/* Mobile drawer — slides from the left. The Sidebar component is
          render-once; when rendered inside Sheet we override its hidden
          class via wrapper styles. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 md:hidden [&>button]:text-[#ECEAE4]"
        >
          {/* Force-show the Sidebar inside the drawer. The inner
              `[&_aside]` selector flips the md:flex → flex so the
              drawer instance renders on small screens. */}
          <div className="h-full [&_aside]:flex [&_aside]:w-full [&_aside]:border-r-0">
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      <main className="flex flex-col overflow-hidden min-w-0 flex-1">
        {/* Topbar — responsive padding, essentials only */}
        <div className="flex items-center gap-2 px-3 sm:px-4 md:px-7 py-3 border-b border-white/10 bg-[#0A0D0F]/70 backdrop-blur-md shrink-0 h-[54px]">
          {/* Mobile hamburger */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="md:hidden w-[30px] h-[30px] rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
            aria-label="Open sidebar"
            title="Menu"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <div className="hidden md:flex items-center gap-2 text-[13px] text-[#8A9198]">
            <span>Workspace</span>
            <span className="text-[#5A6268]">/</span>
            <span className="text-[#ECEAE4]">Studio</span>
          </div>
          <div className="flex-1" />
          <NotificationsPopover />
          <HelpPopover />
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 sm:gap-5 xl:gap-6 px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1480px] mx-auto">
            <div className="col-main flex flex-col gap-6 sm:gap-8 min-w-0">
              <Hero />
              <CreateModeTiles />
              <ProjectsGallery />
            </div>
            {/* Right rail — desktop only. At < xl the page hides it; the
                intake pages show it via their own cost chip + bottom
                sheet, but on the dashboard home we just hide it to let
                the main column breathe on tablet. */}
            <div className="hidden xl:block">
              <RightRail />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
