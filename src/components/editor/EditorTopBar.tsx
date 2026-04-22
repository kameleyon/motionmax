import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Share2, History, Loader2, Menu, ChevronDown } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import NotificationsPopover from '@/components/dashboard/NotificationsPopover';
import HelpPopover from '@/components/dashboard/HelpPopover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { EditorState } from '@/hooks/useEditorState';
import { useExport, PRESET_MAP, type ExportPreset } from './useExport';
import ShareModal from './ShareModal';

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
  const [shareOpen, setShareOpen] = useState(false);
  const { exportState, startExport } = useExport(state);

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

  const exporting = exportState.status === 'submitting' || exportState.status === 'rendering';
  const exportDone = exportState.status === 'done' && exportState.url;

  // Default download = master preset (re-export guarantees latest scene
  // edits are included). If an export is already done we just hand the
  // user the finished URL.
  const handleDefaultExport = () => {
    if (exportDone && exportState.url) {
      window.open(exportState.url, '_blank', 'noopener,noreferrer');
      return;
    }
    startExport('master');
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
        onClick={() => setShareOpen(true)}
        disabled={state.phase !== 'ready' || !project}
        className="hidden md:inline-flex w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Share2 className="w-4 h-4" />
      </button>

      {/* Export primary + preset dropdown */}
      <div className="inline-flex items-stretch shrink-0 rounded-lg overflow-hidden shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]">
        <button
          type="button"
          onClick={handleDefaultExport}
          disabled={exporting || state.phase !== 'ready'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exporting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">
            {exporting
              ? `Exporting · ${exportState.progress}%`
              : exportDone ? 'Download' : 'Export 4K'}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={exporting || state.phase !== 'ready'}
              className="px-1.5 border-l border-[#0A0D0F]/20 bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] text-[#0A0D0F] hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Export preset"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56 rounded-xl bg-[#10151A] border-white/10 text-[#ECEAE4] shadow-xl"
          >
            {(Object.entries(PRESET_MAP) as Array<[ExportPreset, typeof PRESET_MAP[ExportPreset]]>).map(([key, cfg]) => (
              <DropdownMenuItem
                key={key}
                onClick={() => startExport(key)}
                className="cursor-pointer rounded-lg text-[#ECEAE4] focus:bg-white/5 focus:text-[#ECEAE4] flex items-baseline gap-2"
              >
                <span className="font-medium">{cfg.label}</span>
                <span className="text-[10px] font-mono tracking-wider text-[#5A6268] ml-auto">
                  {cfg.format === 'portrait' ? '9:16' : '16:9'} · {cfg.resolution}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

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

      {project && (
        <ShareModal
          open={shareOpen}
          onOpenChange={setShareOpen}
          projectId={project.id}
          projectType={project.project_type ?? null}
        />
      )}
    </div>
  );
}

export type { SubView };
// Re-export for convenience so other editor components import them from
// the same module as the topbar state types.
void Link;
