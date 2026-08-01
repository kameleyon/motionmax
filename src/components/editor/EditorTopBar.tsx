import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Share2, Loader2, Menu, SlidersHorizontal, RotateCw } from 'lucide-react';
import NotificationsPopover from '@/components/dashboard/NotificationsPopover';
import HelpPopover from '@/components/dashboard/HelpPopover';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { EditorState } from '@/hooks/useEditorState';
import { useExport } from './useExport';
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
  saveStatus: 'idle' | 'saving' | 'saved' | 'dirty' | 'error';
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
      // Legacy WorkspaceRouter retired — both branches go to editor.
      navigate(`/app/editor/${data.id}?autostart=1`);
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

  // C-3-1: Real save-status pill. The 'error' state is sticky (set by
  // the saveStatusBus when a write fails) and uses the warning gold so
  // users notice — silently green "Saved" while writes were failing was
  // the data-loss bug we're fixing. Tooltip on the chip explains the
  // retry path; on click users can attempt the last save again via the
  // Inspector control they were using (no global retry hook exists).
  const savePill = {
    idle:   { text: 'Auto-saved',         color: 'text-primary',  dot: 'bg-primary' },
    saved:  { text: 'Saved',              color: 'text-primary',  dot: 'bg-primary' },
    saving: { text: 'Saving…',            color: 'text-primary',  dot: 'bg-primary animate-pulse' },
    dirty:  { text: 'Unsaved changes',    color: 'text-[#E4C875]', dot: 'bg-[#E4C875]' },
    error:  { text: 'Save failed · retry', color: 'text-[#E4C875]', dot: 'bg-[#E4C875] animate-pulse' },
  }[saveStatus];

  const exporting = exportState.status === 'submitting' || exportState.status === 'rendering';
  const exportDone = exportState.status === 'done' && exportState.url;

  // Track which export URL we've already handled so a re-render doesn't
  // re-fire the save. The URL changes per export, so a fresh render
  // fires exactly once. `exportTriggeredByUserRef` marks that THIS
  // session's export was user-initiated, so the completion effect only
  // acts on exports the user started here — never a 'done' rehydrated
  // from a previous visit on mount.
  const handledUrlRef = useRef<string | null>(null);
  const exportTriggeredByUserRef = useRef(false);

  // iOS/iPadOS Safari writes to Photos ONLY via navigator.share, and
  // ONLY while a tap's transient activation is live. A render takes
  // minutes (no gesture left when it finishes) AND any long `await
  // fetch(blob)` inside the eventual tap ALSO burns the activation —
  // which is why the old flow bounced to opening the raw MP4 in a tab.
  // Fix: the moment the export completes, pre-fetch the finished MP4
  // into a File (no gesture needed to fetch) and stash it. The "Save to
  // Photos" tap then calls navigator.share SYNCHRONOUSLY with the cached
  // File, so the gesture survives and the share sheet (→ "Save Video" →
  // Photos) actually appears.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
  const [pendingSave, setPendingSave] = useState<{ url: string; file: File | null; filename: string } | null>(null);

  const buildFilename = () =>
    `${(project?.title ?? 'motionmax').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)}.mp4`;

  const fetchAsFile = async (url: string, filename: string): Promise<File | null> => {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return new File([blob], filename, { type: blob.type || 'video/mp4' });
    } catch {
      return null;
    }
  };

  // Desktop / Android — synthetic anchor download of an in-memory File.
  const saveViaAnchor = (file: File, filename: string) => {
    const objectUrl = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Release the blob a moment later — too-early revoke aborts Safari.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  };

  // iOS "Save to Photos" tap. navigator.share MUST be reached with NO
  // preceding await so the tap's activation is still valid — the File
  // was already pre-fetched by the completion effect below.
  const handleSaveToPhotos = async () => {
    if (!pendingSave) return;
    const { file, url, filename } = pendingSave;
    const nav = navigator as Navigator & {
      canShare?: (data: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    };
    if (file && nav.canShare?.({ files: [file] }) && typeof nav.share === 'function') {
      try {
        await nav.share({ files: [file], title: filename });
        setPendingSave(null); // saved (or dismissed) — button returns to Export
        return;
      } catch (err) {
        // AbortError = user cancelled the sheet; leave the button as
        // "Save to Photos" so they can retry. Any other error falls
        // through to opening the raw file for a manual long-press save.
        if ((err as Error)?.name === 'AbortError') return;
      }
    }
    // Fallback (pre-fetch failed or share unsupported): open the MP4 so
    // the user can long-press → "Save to Photos".
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // On export completion: desktop/Android auto-downloads immediately;
  // iOS pre-warms the File and flips the button to "Save to Photos".
  // Only fires for a this-session, user-initiated export.
  useEffect(() => {
    if (!exportDone || !exportState.url) return;
    if (handledUrlRef.current === exportState.url) return;
    if (!exportTriggeredByUserRef.current) return;

    const url = exportState.url;
    handledUrlRef.current = url;
    exportTriggeredByUserRef.current = false;
    const filename = buildFilename();

    let cancelled = false;
    void (async () => {
      const file = await fetchAsFile(url, filename);
      if (cancelled) return;
      if (isIOS) {
        setPendingSave({ url, file, filename });
      } else if (file) {
        saveViaAnchor(file, filename);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportDone, exportState.url]);

  // Single Export button. Always renders a FRESH master export (ignoring
  // any prior/rehydrated result), then the effect above pushes the save.
  // On iOS the button flips to "Save to Photos" for the final album tap.
  const handlePrimary = () => {
    if (exporting) return;
    if (pendingSave) { void handleSaveToPhotos(); return; }
    exportTriggeredByUserRef.current = true;
    handledUrlRef.current = null;
    setPendingSave(null);
    void startExport();
  };

  return (
    <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 border-b border-white/10 bg-[#0A0D0F]/80 backdrop-blur-md h-16 sm:h-[54px] col-span-full overflow-hidden">
      {/* Mobile hamburger — opens the main nav menu (Studio / Projects /
          Voices / Settings / Log Out). Scenes are NOT in here: on
          mobile, users advance scenes by tapping the stage. */}
      <button
        type="button"
        onClick={onOpenMenuDrawer}
        aria-label="Open menu"
        title="Menu"
        className="lg:hidden w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4]"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* Back button — browser-style: returns to the previous page in
          history rather than always landing on /dashboard-new, so a user
          who opened the editor from /projects (or anywhere else) goes
          back where they came from. */}
      <button
        type="button"
        onClick={() => navigate(-1)}
        aria-label="Go back"
        title="Back"
        className="w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4] transition-colors shrink-0"
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
      <span
        className={`hidden md:inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] uppercase shrink-0 ${savePill.color}`}
        title={
          saveStatus === 'error'
            ? "Last save didn't go through. Try the change again or check your connection."
            : saveStatus === 'saving' ? 'Saving your changes…'
              : saveStatus === 'dirty' ? 'You have unsaved changes'
                : 'All changes are saved'
        }
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${savePill.dot}`} />
        {savePill.text}
      </span>

      {/* Sub-view toggle removed until Script + Storyboard views are
          built. Single Edit view is the default; the subView /
          onSubViewChange props are still on the component signature so
          the caller plumbing stays intact when those two views ship. */}

      {/* Rendering status pill — aria-live=polite so screen readers
          announce progress without interrupting other speech. */}
      {state.phase === 'rendering' && (
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] tracking-[0.1em] uppercase border border-[#14C8CC]/30 text-[#14C8CC] bg-[#14C8CC]/10 shrink-0"
        >
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] animate-pulse" />
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
        // Display class hygiene: was `hidden md:inline-flex ... grid
        // place-items-center` — `grid` overrode the flex, leaving the
        // 44×44 button without proper centering hooks AND the hover
        // bg #151B20 was indistinguishable from the topbar's own
        // background on dark themes (looked like nothing happened on
        // hover). Switched to flex centering + bg-white/[0.06] which
        // reads against any topbar shade. Also tightened to 40×40 so
        // the hover pad doesn't look chunky next to the export pill.
        className="hidden md:inline-flex items-center justify-center w-10 h-10 rounded-md text-[#8A9198] hover:bg-white/[0.06] hover:text-[#ECEAE4] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
        // Same display + hover-bg hygiene as the Share button — see
        // comment above for the rationale.
        className="hidden md:inline-flex items-center justify-center w-10 h-10 rounded-md text-[#8A9198] hover:bg-white/[0.06] hover:text-[#ECEAE4] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {regenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
      </button>

      {/* Export — one button, no preset picker. Tapping renders a fresh
          master export; on completion it auto-downloads (desktop/Android)
          or flips to "Save to Photos" for the iOS album write. */}
      <button
        type="button"
        onClick={handlePrimary}
        // In the "Save to Photos" state the tap only saves an
        // already-rendered file (no mutation), so a lingering
        // project-lock must NOT disable it — only block a fresh render.
        disabled={exporting || (!pendingSave && projectLocked)}
        style={{ touchAction: 'manipulation' }}
        className="inline-flex items-center gap-1.5 px-4 min-h-[44px] shrink-0 rounded-lg text-[12px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_10px_30px_-14px_rgba(20,200,204,0.55)]"
        aria-label={pendingSave ? 'Save to Photos' : 'Export video'}
      >
        {exporting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : pendingSave
            ? <Share2 className="w-3.5 h-3.5" />
            : <Download className="w-3.5 h-3.5" />}
        <span className="whitespace-nowrap">
          {exporting
            ? `Exporting · ${exportState.progress}%`
            : pendingSave
              ? 'Save to Photos'
              : 'Export'}
        </span>
      </button>

      <div className="hidden md:inline-flex items-center gap-1">
        <NotificationsPopover />
        <HelpPopover />
      </div>

      {/* Mobile inspector drawer toggle */}
      <button
        type="button"
        onClick={onOpenInspectorDrawer}
        aria-label="Open inspector"
        className="lg:hidden w-11 h-11 rounded-md grid place-items-center text-[#8A9198] hover:bg-[#151B20] hover:text-[#ECEAE4]"
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
