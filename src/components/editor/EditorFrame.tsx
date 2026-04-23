import { useEffect, useState, type ReactNode } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import MiniSidebar from './MiniSidebar';
import EditorTopBar, { type SubView } from './EditorTopBar';
import type { EditorState } from '@/hooks/useEditorState';
import Sidebar from '@/components/dashboard/Sidebar';

/** Responsive CSS-Grid shell:
 *
 *    ≥ 1280px       — 64 / 260 / 1fr / 300  ·  54 / 1fr / 180
 *    1000-1279px    — 64 / 220 / 1fr / 280  ·  same rows
 *    860-999px      — 64 / drawer / 1fr / drawer
 *    < 860px        — drawer / full-screen stage / drawer
 *
 *  The scenes / stage / inspector / timeline slots are supplied by
 *  children so this frame can host the rendering phase layout and the
 *  ready phase layout without repeating grid math. */
export default function EditorFrame({
  state,
  subView,
  onSubViewChange,
  saveStatus,
  scenes,
  stage,
  inspector,
  timeline,
  fullscreen,
}: {
  state: EditorState;
  subView: SubView;
  onSubViewChange: (v: SubView) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'dirty';
  scenes: ReactNode;
  stage: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
  /** True while the user is in fullscreen preview mode. When set,
   *  EditorFrame hides the topbar / sidebar / scenes / inspector /
   *  timeline and lets the stage own the entire viewport. The stage
   *  itself renders an Exit button that flips this back. */
  fullscreen?: boolean;
}) {
  // Mobile-only drawers. Scenes is intentionally NOT exposed to phones —
  // users click the stage to walk through scenes, timeline Prev/Next to
  // jump, so a redundant scene list drawer would just eat screen height.
  const [menuDrawerOpen, setMenuDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);

  // Lock body scroll while fullscreen so phantom scrollbars never show.
  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [fullscreen]);

  // Fullscreen branch — only the stage renders, in a fixed
  // viewport-covering container. No topbar / sidebar / scenes /
  // inspector / timeline. The stage handles its own Exit button.
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[9998] bg-black overflow-hidden">
        {stage}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0A0D0F] text-[#ECEAE4] font-sans overflow-hidden">
      {/* Filmic grain */}
      <div
        className="fixed inset-0 pointer-events-none z-[200] opacity-5 mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.2 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
        }}
      />

      {/* Icon-only sidebar on desktop. Hidden on mobile — the hamburger
          opens the full menu drawer instead. */}
      <div className="hidden lg:flex">
        <MiniSidebar />
      </div>

      <main
        className="flex flex-col flex-1 min-w-0 overflow-hidden"
      >
        <EditorTopBar
          state={state}
          subView={subView}
          onSubViewChange={onSubViewChange}
          saveStatus={saveStatus}
          onOpenMenuDrawer={() => setMenuDrawerOpen(true)}
          onOpenInspectorDrawer={() => setInspectorDrawerOpen(true)}
        />

        {/* Editor grid body. CSS Grid collapses columns by breakpoint:
            ≥1280: 260 | 1fr | 300
            1024-1279: 220 | 1fr | 280
            < 1024: 1fr (scenes + inspector hidden; accessed via drawer).
            Timeline spans full width at the bottom (180px; 140px mobile). */}
        <div className="grid flex-1 min-h-0 overflow-hidden grid-cols-1 lg:grid-cols-[220px_1fr_280px] xl:grid-cols-[260px_1fr_300px] grid-rows-[1fr_140px] sm:grid-rows-[1fr_160px] lg:grid-rows-[1fr_180px]">
          {/* Scenes column (desktop only — mobile uses the drawer) */}
          <aside
            className="border-r border-white/5 bg-[#10151A] overflow-y-auto row-start-1 hidden lg:block lg:col-start-1"
          >
            {scenes}
          </aside>

          {/* Stage */}
          <section className="row-start-1 col-start-1 lg:col-start-2 overflow-hidden min-w-0 bg-[#050709]">
            {stage}
          </section>

          {/* Inspector (desktop only) */}
          <aside
            className="border-l border-white/5 bg-[#10151A] overflow-y-auto row-start-1 hidden lg:block lg:col-start-3"
          >
            {inspector}
          </aside>

          {/* Timeline — spans full width */}
          <section
            className="border-t border-white/5 bg-[#10151A] overflow-hidden row-start-2 col-start-1 lg:col-span-3"
          >
            {timeline}
          </section>
        </div>
      </main>

      {/* Mobile nav drawer — uses the SAME Sidebar component the
          Dashboard + Intake pages use, so the menu is identical
          everywhere. Wrapper overrides the aside's hidden+overflow so
          it renders inside the drawer and scrolls freely, meaning Log
          Out stays reachable on short viewports. */}
      <Sheet open={menuDrawerOpen} onOpenChange={setMenuDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 lg:hidden [&>button]:text-[#ECEAE4]"
        >
          <div className="h-full overflow-y-auto [&_aside]:flex [&_aside]:w-full [&_aside]:border-r-0 [&_aside]:h-auto [&_aside]:min-h-full [&_aside]:overflow-visible [&_aside_nav]:overflow-visible">
            <Sidebar />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile inspector drawer. The Sheet primitive renders a close
          button absolutely-positioned at top-4 right-4. We:
          - push the close button higher (top-2 right-2 via &>button
            selector) so it has more finger-room;
          - drop the tab row down to pt-12 so the X never sits on top
            of the SCENE / VOICE / CAPTIONS / MOTION tabs. */}
      <Sheet open={inspectorDrawerOpen} onOpenChange={setInspectorDrawerOpen}>
        <SheetContent
          side="right"
          className="w-[320px] p-0 bg-[#10151A] border-white/10 lg:hidden [&>button]:text-[#ECEAE4] [&>button]:top-2 [&>button]:right-2 [&>button]:z-20"
        >
          <div className="h-full overflow-y-auto pt-12">{inspector}</div>
        </SheetContent>
      </Sheet>
      {void scenes /* unused on mobile by design */}
    </div>
  );
}
