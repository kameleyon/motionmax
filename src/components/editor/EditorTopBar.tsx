import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Share2, Loader2, Menu, ChevronDown, SlidersHorizontal, RotateCw } from 'lucide-react';
import NotificationsPopover from '@/components/dashboard/NotificationsPopover';
import HelpPopover from '@/components/dashboard/HelpPopover';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { isFlagOn } from '@/lib/featureFlags';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { EditorState } from '@/hooks/useEditorState';
import { useExport, PRESET_MAP, type ExportPreset } from './useExport';
import ShareModal from './ShareModal';
import { useActiveJobs } from './useActiveJobs';

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
  onOpenMenuDrawer,
  onOpenInspectorDrawer,
}: {
  state: EditorState;
  subView: SubView;
  onSubViewChange: (v: SubView) => void;
  saveStatus: 'idle' | 'saving' | 'saved' | 'dirty';
  /** Opens the mobile navigation drawer (Studio / Projects / Voices /
   *  Settings / Log Out). Desktop users see the MiniSidebar instead. */
  onOpenMenuDrawer?: () => void;
  /** Opens the mobile inspector drawer (Scene tab etc.). */
  onOpenInspectorDrawer?: () => void;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [shareOpen, setShareOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const { exportState, startExport } = useExport(state);
  // Project-wide lock: any bulk op in flight (export, voice apply-all,
  // motion apply-all, master_audio regen) freezes the topbar actions
  // so users can't kick another job while the current one is mid-air.
  const { bulkOpActive } = useActiveJobs(state.project?.id ?? null);
  const projectLocked = bulkOpActive || state.phase !== 'ready';

  /** Spawn a fresh project copying every intake field from the
   *  current one, then route into the new editor with autostart=1.
   *  Source project is untouched. Same flow as the All Projects
   *  card menu's "Regenerate" — extracted here so users editing a
   *  project can trigger it without leaving for the projects page. */
  const handleRegenerate = async () => {
    if (!user?.id || !state.project?.id) return;
    setRegenerating(true);
    try {
      const { data: src, error: srcErr } = await supabase
        .from('projects').select('*').eq('id', state.project.id).single();
      if (srcErr || !src) throw new Error(srcErr?.message ?? 'Source project not found');

      // Cast through `unknown` because character_images / intake_settings
      // exist as DB columns but were added after the generated types were
      // last regenerated; the row type is missing them.
      const srcAny = src as unknown as Record<string, unknown>;
      const cloneInsert = {
        user_id: user.id,
        title: `${src.title} (regenerated)`,
        content: src.content,
        project_type: src.project_type,
        format: src.format,
        length: src.length,
        voice_name: src.voice_name,
        voice_inclination: src.voice_inclination,
        style: src.style,
        character_description: src.character_description,
        character_consistency_enabled: src.character_consistency_enabled,
        character_images: srcAny.character_images ?? null,
        intake_settings: srcAny.intake_settings ?? {},
      };
      const { data, error } = await supabase
        .from('projects').insert(cloneInsert as never).select('id').single();
      if (error || !data) throw new Error(error?.message ?? 'Insert returned no row');

      toast.success('New project created — kicking off generation…');
      const editorRoute = isFlagOn('UNIFIED_EDITOR')
        ? `/app/editor/${data.id}?autostart=1`
        : `/app/create?project=${data.id}&autostart=1`;
      navigate(editorRoute);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("Couldn't start regeneration", { description: msg });
    } finally {
      setRegenerating(false);
    }
  };

  const project = state.project;
  const sceneCount = state.scenes.length;
  const modeLabel = project?.project_type === 'doc2video'
    ? 'Explainer'
    : project?.project_type === 'smartflow'
      ? 'Smart Flow'
      : 'Cinematic';

  const savePill = {
    idle:   { text: '● Auto-saved', color: 'text-[#14C8CC]' },
    saved:  { text: '● Auto-saved', color: 'text-[#14C8CC]' },
    saving: { text: '● Saving…',    color: 'text-[#14C8CC]' },
    dirty:  { text: '● Unsaved',    color: 'text-[#E4C875]' },
  }[saveStatus];

  const exporting = exportState.status === 'submitting' || exportState.status === 'rendering';
  const exportDone = exportState.status === 'done' && exportState.url;

  // Track which export URLs we've already auto-downloaded so a re-render
  // of EditorTopBar (e.g. after a state change) doesn't re-fire the
  // browser save dialog. The export URL changes between exports, so
  // queueing a fresh export with new edits will fire a new download
  // exactly once. Also track whether the CURRENT export was kicked off
  // by a user gesture in this session — Safari/Chrome allow programmatic
  // anchor-clicks when the tab has had a recent user gesture, which the
  // Export-button click satisfies.
  const autoDownloadedRef = useRef<string | null>(null);
  const exportTriggeredByUserRef = useRef(false);

  /** Save the exported MP4. Three paths by platform:
   *
   *   1. iOS/iPadOS Safari — the `<a download>` attribute is ignored,
   *      which is why users were seeing the video render in a tab and
   *      never getting the "Save to Photos" action. Instead we use
   *      `navigator.share({ files: [...] })` to open the native iOS
   *      share sheet, which INCLUDES a "Save Video" action that
   *      writes the clip straight to the Photos album.
   *
   *   2. Desktop + Android Chrome — fetch to a blob, create an
   *      object URL, click a synthetic `<a download>` so the file
   *      lands in the Downloads folder (same-origin bypass for
   *      cross-origin MP4s that would otherwise stream inline).
   *
   *   3. Anything that rejects both paths — open the raw URL in a
   *      new tab so the user can at least long-press / Save As. */
  const downloadVideo = async (url: string, filename: string) => {
    // Fetch the blob once; reuse for either share or download.
    let blob: Blob;
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blob = await res.blob();
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    const file = new File([blob], filename, { type: blob.type || 'video/mp4' });

    // iOS path — Web Share sheet → "Save Video" writes to Photos.
    const nav = navigator as Navigator & {
      canShare?: (data: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
    };
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
    if (
      (isIOS || !('download' in HTMLAnchorElement.prototype)) &&
      nav.canShare?.({ files: [file] }) &&
      typeof nav.share === 'function'
    ) {
      try {
        await nav.share({ files: [file], title: filename });
        return;
      } catch (err) {
        // AbortError just means the user cancelled the sheet — don't
        // fall through to download in that case, they made a choice.
        if ((err as Error)?.name === 'AbortError') return;
        // Any other error → fall through to the anchor-download path.
      }
    }

    // Desktop / Android path — synthetic anchor download.
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Release the blob a moment later — too-early revoke aborts Safari.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  };

  // Default download = master preset (re-export guarantees latest scene
  // edits are included). If an export is already done we just hand the
  // user the finished URL.
  const handleDefaultExport = () => {
    if (exportDone && exportState.url) {
      const title = (project?.title ?? 'motionmax').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
      void downloadVideo(exportState.url, `${title}.mp4`);
      return;
    }
    // Mark that THIS session's export was user-initiated so the
    // auto-download effect below is allowed to fire the file save
    // without bouncing off Safari's user-gesture gate.
    exportTriggeredByUserRef.current = true;
    autoDownloadedRef.current = null;
    startExport('master');
  };

  // Auto-download the exported MP4 the moment the job completes — no
  // second click required. Chrome/Firefox always honour programmatic
  // anchor-downloads; Safari is stricter but accepts them when the
  // tab has had a recent user gesture, which our Export button click
  // provides. iOS is the exception: `navigator.share({ files })`
  // REQUIRES a live user gesture, so on iPhone/iPad we intentionally
  // skip the auto-fire and leave the button as "Save / Download" for
  // the user to tap — that's the only way iOS will let us open the
  // share sheet for Save-to-Photos.
  useEffect(() => {
    if (!exportDone || !exportState.url) return;
    if (autoDownloadedRef.current === exportState.url) return;
    if (!exportTriggeredByUserRef.current) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
    if (isIOS) return; // iOS needs the second tap for Save-to-Photos.

    autoDownloadedRef.current = exportState.url;
    const title = (project?.title ?? 'motionmax').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
    void downloadVideo(exportState.url, `${title}.mp4`);
    // Clear the gesture flag so a stale completed state from another
    // event source (e.g. realtime) doesn't re-fire downloads.
    exportTriggeredByUserRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDone, exportState.url]);

  return (
    <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 border-b border-white/10 bg-[#0A0D0F]/80 backdrop-blur-md h-[54px] col-span-full overflow-hidden">
      {/* Mobile hamburger — opens the main nav menu (Studio / Projects /
          Voices / Settings / Log Out). Scenes are NOT in here: on
          mobile, users advance scenes by tapping the stage. */}
      <button
        type="button"
        onClick={onOpenMenuDrawer}
        aria-label="Open menu"
        title="Menu"
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

      {/* Sub-view toggle removed until Script + Storyboard views are
          built. Single Edit view is the default; re-enable this when
          the other two have actual content to render. */}
      {void subView}
      {void onSubViewChange}

      {/* Rendering status pill */}
      {state.phase === 'rendering' && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] tracking-[0.1em] uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] animate-pulse" />
          Rendering · {state.progress}%
        </span>
      )}

      {/* Share */}
      <button
        type="button"
        title="Share"
        aria-label="Share"
        onClick={() => setShareOpen(true)}
        disabled={projectLocked || !project}
        className="hidden md:inline-flex w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Share2 className="w-4 h-4" />
      </button>

      {/* Regenerate — spawns a NEW project copying every intake
          field from the current one. Source project is left alone.
          Disabled while a regen is mid-flight to avoid double-clicks
          spawning two clones, AND during a bulk op so users don't
          spam clones while editing is locked. */}
      <button
        type="button"
        title="Regenerate as a new project"
        aria-label="Regenerate as a new project"
        onClick={handleRegenerate}
        disabled={regenerating || projectLocked || !project}
        className="hidden md:inline-flex w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {regenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
      </button>

      {/* Export primary + preset dropdown */}
      <div className="inline-flex items-stretch shrink-0 rounded-lg overflow-hidden shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]">
        <button
          type="button"
          onClick={handleDefaultExport}
          disabled={exporting || projectLocked}
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
              disabled={exporting || projectLocked}
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
      </div>

      {/* Mobile inspector drawer toggle */}
      <button
        type="button"
        onClick={onOpenInspectorDrawer}
        aria-label="Open inspector"
        className="lg:hidden w-8 h-8 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4]"
        title="Edit scene"
      >
        <SlidersHorizontal className="w-4 h-4" />
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
