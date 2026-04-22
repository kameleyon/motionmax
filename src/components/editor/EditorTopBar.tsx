import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Share2, History, Loader2, Menu } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import NotificationsPopover from '@/components/dashboard/NotificationsPopover';
import HelpPopover from '@/components/dashboard/HelpPopover';
import type { EditorState } from '@/hooks/useEditorState';

type SubView = 'edit' | 'script' | 'storyboard';

/** Editor top bar — Back, project title + meta, autosave pill,
 *  Edit/Script/Storyboard segmented toggle, rendering pill (while
 *  active), History/Share/Export, utility icons. Mobile gets a
 *  hamburger that exposes the same actions in a bottom sheet
 *  (implementation of the sheet lives in the parent EditorFrame). */
export default function EditorTopBar({
  state,
  subView,
  onSubViewChange,
  saveStatus,
  onOpenSceneDrawer,
  onOpenInspectorDrawer,
}: {
  state: EditorState;
  subView: SubView;
  onSubViewChange: (v: SubView) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'dirty';
  onOpenSceneDrawer?: () => void;
  onOpenInspectorDrawer?: () => void;
}) {
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);

  const project = state.project;
  const sceneCount = state.scenes.length;
  const modeLabel = project?.project_type === 'doc2video'
    ? 'Explainer'
    : project?.project_type === 'smartflow'
      ? 'Smart Flow'
      : 'Cinematic';

  const savePill = {
    idle:   { text: '● Auto-saved', color: 'text-[#5CD68D]' },
    saved:  { text: '● Auto-saved', color: 'text-[#5CD68D]' },
    saving: { text: '● Saving…',    color: 'text-[#14C8CC]' },
    dirty:  { text: '● Unsaved',    color: 'text-[#E4C875]' },
  }[saveStatus];

  const handleExport = () => {
    // Export wiring lives in Phase 7 — this is a placeholder that
    // flips the button into a loading state for design review.
    setExporting(true);
    setTimeout(() => setExporting(false), 1500);
  };

  return (
    <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 border-b border-white/10 bg-[#0A0D0F]/80 backdrop-blur-md h-[54px] col-span-full overflow-hidden">
      {/* Mobile hamburger — opens the scenes/inspector drawer on small screens */}
      <button
        type="button"
        onClick={onOpenSceneDrawer}
        aria-label="Open scenes"
        className="lg:hidden w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4]"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* Back button */}
      <button
        type="button"
        onClick={() => navigate('/dashboard-new')}
        aria-label="Back to dashboard"
        title="Back to Studio"
        className="w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors shrink-0"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      {/* Title + subtitle */}
      <div className="min-w-0 flex-1 flex items-baseline gap-2">
        <h1 className="font-serif text-[14px] sm:text-[16px] md:text-[17px] font-medium text-[#ECEAE4] tracking-tight truncate m-0">
          {project?.title || 'Untitled project'}
        </h1>
        <span className="hidden sm:inline text-[12px] text-[#8A9198] truncate">
          · {modeLabel} · {sceneCount} scenes
        </span>
      </div>

      {/* Autosave */}
      <span className={`hidden md:inline font-mono text-[10px] tracking-[0.12em] uppercase shrink-0 ${savePill.color}`}>
        {savePill.text}
      </span>

      {/* Sub-view toggle — Edit / Script / Storyboard */}
      <div className="hidden md:inline-flex gap-[2px] p-[3px] bg-[#151B20] rounded-lg border border-white/5 shrink-0">
        {(['edit', 'script', 'storyboard'] as SubView[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onSubViewChange(v)}
            className={
              'px-3 py-1 font-mono text-[10.5px] tracking-[0.1em] uppercase rounded-md transition-colors ' +
              (v === subView
                ? 'bg-[#10151A] text-[#ECEAE4]'
                : 'text-[#8A9198] hover:text-[#ECEAE4]')
            }
          >
            {v}
          </button>
        ))}
      </div>

      {/* Rendering status pill */}
      {state.phase === 'rendering' && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] tracking-[0.1em] uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] animate-pulse" />
          Rendering · {state.progress}%
        </span>
      )}

      {/* History */}
      <button
        type="button"
        title="Version history"
        aria-label="Version history"
        className="hidden md:inline-flex w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
      >
        <History className="w-4 h-4" />
      </button>

      {/* Share */}
      <button
        type="button"
        title="Share"
        aria-label="Share"
        className="hidden md:inline-flex w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors"
      >
        <Share2 className="w-4 h-4" />
      </button>

      {/* Export primary */}
      <button
        type="button"
        onClick={handleExport}
        disabled={exporting || state.phase !== 'ready'}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)] disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        {exporting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <Download className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline">{exporting ? 'Exporting…' : 'Export 4K'}</span>
      </button>

      <div className="hidden md:inline-flex items-center gap-1">
        <NotificationsPopover />
        <HelpPopover />
        <ThemeToggle />
      </div>

      {/* Mobile inspector drawer toggle */}
      <button
        type="button"
        onClick={onOpenInspectorDrawer}
        aria-label="Open inspector"
        className="lg:hidden w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4]"
        title="Inspector"
      >
        <Menu className="w-4 h-4 rotate-90" />
      </button>
    </div>
  );
}

/** Need a global Link import for MiniSidebar Nav entries. We don't use
 *  it directly here but this file is a natural home for the shared
 *  "top-bar state" type in future phases. */
export type { SubView };
void Link;
