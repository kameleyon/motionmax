import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WifiOff, GripVertical, GripHorizontal } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import MiniSidebar from './MiniSidebar';
import EditorTopBar, { type SubView } from './EditorTopBar';
import BulkOpModal from './BulkOpModal';
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

  // Layout state — collapsible side panels + draggable timeline.
  // Persists per-browser via localStorage so the user's layout sticks
  // across sessions. Mobile (< lg) doesn't use these — scenes column
  // and inspector are accessed via drawers there. Timeline height
  // is clamped to [140, 360] so it stays usable: 140 fits 3 tracks,
  // 360 fits all 5 (Video / Voice / Captions / Music / SFX) with
  // breathing room.
  const [scenesCollapsed, setScenesCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('mm.editor.scenesCollapsed') === '1';
  });
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('mm.editor.inspectorCollapsed') === '1';
  });
  const [timelineHeight, setTimelineHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 180;
    const saved = parseInt(localStorage.getItem('mm.editor.timelineH') ?? '180', 10);
    return Number.isFinite(saved) ? Math.min(360, Math.max(140, saved)) : 180;
  });

  useEffect(() => {
    localStorage.setItem('mm.editor.scenesCollapsed', scenesCollapsed ? '1' : '0');
  }, [scenesCollapsed]);
  useEffect(() => {
    localStorage.setItem('mm.editor.inspectorCollapsed', inspectorCollapsed ? '1' : '0');
  }, [inspectorCollapsed]);
  useEffect(() => {
    localStorage.setItem('mm.editor.timelineH', String(timelineHeight));
  }, [timelineHeight]);

  // Drag state for the timeline resize handle. Tracks the pointer's
  // starting Y + the timeline's starting height so the user can drag
  // smoothly without jitter. Clamped to [140, 360] on every move.
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const clientY = 'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
      // Dragging UP = larger timeline (deltaY negative → height grows)
      const delta = drag.startY - clientY;
      const next = Math.min(360, Math.max(140, drag.startH + delta));
      setTimelineHeight(next);
    };
    const onUp = () => { dragStateRef.current = null; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    };
  }, []);
  const startResize = (clientY: number) => {
    dragStateRef.current = { startY: clientY, startH: timelineHeight };
    document.body.style.userSelect = 'none';
  };

  // Offline banner — react-query retries + Supabase realtime will
  // silently eat updates when the tab goes offline (job status won't
  // reach the UI, and regen clicks will queue to an unreachable DB).
  // Surface it so users don't think the app is broken.
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

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
        <BulkOpModal projectId={state.project?.id} />
      </div>
    );
  }

  const offlineBanner = !online ? (
    <div className="w-full bg-[#E4C875]/15 border-b border-[#E4C875]/30 text-[#F2E2B4] text-[11.5px] font-mono tracking-wider uppercase px-3 py-1.5 flex items-center justify-center gap-2">
      <WifiOff className="w-3.5 h-3.5" />
      You're offline — new edits + regens will retry when the connection returns.
    </div>
  ) : null;

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
        {offlineBanner}
        <EditorTopBar
          state={state}
          subView={subView}
          onSubViewChange={onSubViewChange}
          saveStatus={saveStatus}
          onOpenMenuDrawer={() => setMenuDrawerOpen(true)}
          onOpenInspectorDrawer={() => setInspectorDrawerOpen(true)}
        />

        {/* Editor grid body — fully dynamic at lg+:
              • Scenes column: 240px (or 32px when collapsed)
              • Stage:         1fr
              • Inspector:     290px (or 32px when collapsed)
              • Timeline row:  user-draggable, clamped [140, 360]
            Mobile/tablet (< lg) keeps the single-column layout with
            scenes + inspector hidden behind drawers. Inline grid
            template via CSS variable so we don't have to fight
            Tailwind's static class system. */}
        <div
          className="grid flex-1 min-h-0 overflow-hidden grid-cols-1 lg:[grid-template-columns:var(--mm-cols)]"
          style={{
            // grid-template-rows: stage flex + handle 6px + timeline (user height)
            gridTemplateRows: `1fr 6px ${timelineHeight}px`,
            // CSS variable consumed only at lg+ — mobile sticks with grid-cols-1.
            ['--mm-cols' as string]: `${scenesCollapsed ? '32px' : '240px'} 1fr ${inspectorCollapsed ? '32px' : '290px'}`,
          } as React.CSSProperties}
        >
          {/* Scenes column (desktop only) — collapse handle uses the
              same 6-dot GripVertical icon family as the timeline
              grip, on a plain dark background. Subtle by default,
              brightens on hover. No aqua tinting, no chevron pills. */}
          <aside
            className="relative border-r border-white/5 bg-[#10151A] row-start-1 hidden lg:block lg:col-start-1 overflow-hidden"
          >
            {scenesCollapsed ? (
              <button
                type="button"
                onClick={() => setScenesCollapsed(false)}
                title="Show scenes panel"
                aria-label="Expand scenes panel"
                className="w-full h-full grid place-items-center bg-[#0A0D0F] hover:bg-[#1B2228] text-[#5A6268] hover:text-[#ECEAE4] transition-colors"
              >
                <GripVertical className="w-4 h-4" />
              </button>
            ) : (
              <>
                <div className="h-full overflow-y-auto pr-1">{scenes}</div>
                <button
                  type="button"
                  onClick={() => setScenesCollapsed(true)}
                  title="Collapse scenes panel"
                  aria-label="Collapse scenes panel"
                  className="absolute top-0 right-0 bottom-0 z-10 w-1.5 bg-[#0A0D0F] hover:bg-[#1B2228] transition-colors flex items-center justify-center group cursor-pointer"
                >
                  <GripVertical className="w-3 h-3 text-[#5A6268] group-hover:text-[#ECEAE4]" />
                </button>
              </>
            )}
          </aside>

          {/* Stage */}
          <section className="row-start-1 col-start-1 lg:col-start-2 overflow-hidden min-w-0 bg-[#050709]">
            {stage}
          </section>

          {/* Inspector (desktop only) — mirrored, same understated
              GripVertical treatment as the scenes column. */}
          <aside
            className="relative border-l border-white/5 bg-[#10151A] row-start-1 hidden lg:block lg:col-start-3 overflow-hidden"
          >
            {inspectorCollapsed ? (
              <button
                type="button"
                onClick={() => setInspectorCollapsed(false)}
                title="Show inspector panel"
                aria-label="Expand inspector panel"
                className="w-full h-full grid place-items-center bg-[#0A0D0F] hover:bg-[#1B2228] text-[#5A6268] hover:text-[#ECEAE4] transition-colors"
              >
                <GripVertical className="w-4 h-4" />
              </button>
            ) : (
              <>
                <div className="h-full overflow-y-auto pl-1">{inspector}</div>
                <button
                  type="button"
                  onClick={() => setInspectorCollapsed(true)}
                  title="Collapse inspector panel"
                  aria-label="Collapse inspector panel"
                  className="absolute top-0 left-0 bottom-0 z-10 w-1.5 bg-[#0A0D0F] hover:bg-[#1B2228] transition-colors flex items-center justify-center group cursor-pointer"
                >
                  <GripVertical className="w-3 h-3 text-[#5A6268] group-hover:text-[#ECEAE4]" />
                </button>
              </>
            )}
          </aside>

          {/* Timeline resize handle — 6px tall draggable bar above the
              timeline. Drag UP to grow, DOWN to shrink. Clamped to
              [140, 360]. Subtle by default, brightens on hover so the
              user can find it without it being visually noisy. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize timeline"
            title="Drag to resize the timeline"
            onMouseDown={(e) => { e.preventDefault(); startResize(e.clientY); }}
            onTouchStart={(e) => { startResize(e.touches[0]?.clientY ?? 0); }}
            className="row-start-2 col-start-1 lg:col-span-3 group cursor-row-resize bg-[#0A0D0F] hover:bg-[#1B2228] transition-colors flex items-center justify-center"
          >
            <GripHorizontal className="w-4 h-4 text-[#5A6268] group-hover:text-[#ECEAE4]" />
          </div>

          {/* Timeline — spans full width, height controlled by user */}
          <section
            className="border-t border-white/5 bg-[#10151A] overflow-hidden row-start-3 col-start-1 lg:col-span-3"
          >
            {timeline}
          </section>
        </div>
      </main>

      {/* Bulk-op progress modal — renders ONLY while bulkOpActive
          (export / voice-apply-all / captions-apply / motion-apply-all).
          Sits on top of the editor at z-[10000] with verbose rotating
          status messages + REC timecode + percentage. */}
      <BulkOpModal projectId={state.project?.id} />

      {/* Mobile nav drawer — uses the SAME Sidebar component the
          Dashboard + Intake pages use, so the menu is identical
          everywhere. Wrapper overrides the aside's hidden+overflow so
          it renders inside the drawer and scrolls freely, meaning Log
          Out stays reachable on short viewports. */}
      <Sheet open={menuDrawerOpen} onOpenChange={setMenuDrawerOpen}>
        <SheetContent
          side="left"
          className="w-[280px] p-0 bg-[#10151A] border-white/10 lg:hidden [&>button]:text-[#ECEAE4]"
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
