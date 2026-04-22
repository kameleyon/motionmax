import { useState, type ReactNode } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import MiniSidebar from './MiniSidebar';
import EditorTopBar, { type SubView } from './EditorTopBar';
import type { EditorState } from '@/hooks/useEditorState';

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
}: {
  state: EditorState;
  subView: SubView;
  onSubViewChange: (v: SubView) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'dirty';
  scenes: ReactNode;
  stage: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
}) {
  const [scenesDrawerOpen, setScenesDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);

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

      <MiniSidebar />

      <main
        className="flex flex-col flex-1 min-w-0 overflow-hidden"
      >
        <EditorTopBar
          state={state}
          subView={subView}
          onSubViewChange={onSubViewChange}
          saveStatus={saveStatus}
          onOpenSceneDrawer={() => setScenesDrawerOpen(true)}
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

      {/* Mobile scenes drawer */}
      <Sheet open={scenesDrawerOpen} onOpenChange={setScenesDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 lg:hidden [&>button]:text-[#ECEAE4]"
        >
          <div className="h-full overflow-y-auto">{scenes}</div>
        </SheetContent>
      </Sheet>

      {/* Mobile inspector drawer */}
      <Sheet open={inspectorDrawerOpen} onOpenChange={setInspectorDrawerOpen}>
        <SheetContent
          side="right"
          className="w-[320px] p-0 bg-[#10151A] border-white/10 lg:hidden [&>button]:text-[#ECEAE4]"
        >
          <div className="h-full overflow-y-auto">{inspector}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
