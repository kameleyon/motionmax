import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Sidebar from '@/components/dashboard/Sidebar';
import NotificationsPopover from '@/components/dashboard/NotificationsPopover';
import HelpPopover from '@/components/dashboard/HelpPopover';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { type ProjectMode, MODE_LABEL } from './types';

/** Everything the form on the left column needs to drive the right rail
 *  — which on mobile is hidden behind a "Total · N cr" chip. Provided by
 *  IntakeForm, consumed by the cost chip. */
type IntakeRailBridge = {
  totalCost: number;
  railContent: ReactNode;   // the full preview/storyboard/cost/CTA stack
  setRailContent: (n: ReactNode) => void;
  setTotalCost: (n: number) => void;
};

const RailCtx = createContext<IntakeRailBridge | null>(null);
export function useIntakeRail() {
  const v = useContext(RailCtx);
  if (!v) throw new Error('useIntakeRail must be used inside <IntakeFrame>');
  return v;
}

/** Primary wrapper — mirrors DashboardLayout's responsive behaviour,
 *  minus the dashboard-specific topbar actions (LIVE pill, "New
 *  project"). Form pages pass their body as children and register their
 *  right-rail content via `useIntakeRail().setRailContent(...)`. */
export default function IntakeFrame({
  mode,
  children,
}: {
  mode: ProjectMode;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [railContent, setRailContent] = useState<ReactNode>(null);
  const [totalCost, setTotalCost] = useState(0);

  const bridge = useMemo<IntakeRailBridge>(
    () => ({ totalCost, railContent, setRailContent, setTotalCost }),
    [totalCost, railContent],
  );

  return (
    <RailCtx.Provider value={bridge}>
      <div className="flex h-screen relative bg-[#0A0D0F] text-[#ECEAE4] font-sans overflow-hidden">
        {/* filmic grain */}
        <div
          className="fixed inset-0 pointer-events-none z-[200] opacity-5 mix-blend-overlay"
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
          >
            <div className="h-full [&_aside]:flex [&_aside]:w-full [&_aside]:border-r-0">
              <Sidebar />
            </div>
          </SheetContent>
        </Sheet>

        <main className="flex flex-col overflow-hidden min-w-0 flex-1">
          {/* Topbar — no LIVE pill, no New project. Mobile: hamburger +
              breadcrumb condensed to just the mode. */}
          <div className="flex items-center gap-2 px-3 sm:px-4 md:px-7 py-3 border-b border-white/10 bg-[#0A0D0F]/70 backdrop-blur-md shrink-0 h-[54px]">
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

            <div className="hidden md:flex items-center gap-2 text-[13px] text-[#8A9198] min-w-0">
              <Link to="/dashboard-new" className="hover:text-[#ECEAE4] transition-colors" style={{ textDecoration: 'none' }}>
                Workspace
              </Link>
              <span className="text-[#5A6268]">/</span>
              <span className="text-[#8A9198]">Create</span>
              <span className="text-[#5A6268]">/</span>
              <span className="text-[#ECEAE4] truncate">{MODE_LABEL[mode]}</span>
            </div>
            {/* Mobile breadcrumb — just the mode */}
            <div className="md:hidden flex items-center gap-1.5 text-[12px] text-[#ECEAE4] min-w-0">
              <span className="font-mono text-[9.5px] tracking-widest uppercase text-[#14C8CC]">{MODE_LABEL[mode]}</span>
            </div>

            <div className="flex-1" />

            {/* Mobile cost chip — opens the bottom sheet with the full
                right rail. Desktop keeps the full rail visible, so this
                chip hides at ≥ lg. */}
            <button
              type="button"
              onClick={() => setMobileRailOpen(true)}
              className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10.5px] tracking-widest uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10 hover:bg-[#14C8CC]/20 transition-colors"
              aria-label={`Total ${totalCost} credits — tap for preview and options`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-80">
                <circle cx="12" cy="12" r="9" />
                <path d="M9 10h6M9 14h4" />
              </svg>
              {totalCost} cr
            </button>

            <NotificationsPopover />
            <HelpPopover />
            <ThemeToggle />
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-white/10">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 sm:gap-5 lg:gap-6 px-3 sm:px-4 md:px-6 lg:px-8 py-5 sm:py-7 max-w-[1380px] mx-auto">
              <div className="col-main flex flex-col min-w-0">
                {children}
              </div>

              {/* Desktop right rail */}
              <aside className="hidden lg:block">
                <div className="sticky top-5 flex flex-col gap-4">
                  {railContent}
                </div>
              </aside>
            </div>
          </div>
        </main>

        {/* Mobile right-rail bottom sheet */}
        <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
          <SheetContent
            side="bottom"
            className="lg:hidden bg-[#10151A] border-white/10 max-h-[85vh] overflow-y-auto p-4 sm:p-5 [&>button]:text-[#ECEAE4]"
          >
            <div className="flex flex-col gap-4">
              {railContent}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </RailCtx.Provider>
  );
}
