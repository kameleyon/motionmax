import { useEffect, useState } from 'react';
import { useActiveJobs } from './useActiveJobs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';

/** Full-screen modal that shows progress for project-wide operations:
 *  exports, voice apply-all, captions burn, and motion re-render-all.
 *  Rotates through verbose status messages on a timer so the user sees
 *  movement even while the worker is in a long phase. Driven entirely
 *  by useActiveJobs — appears when bulkOpActive flips true and goes
 *  away when it flips false. */

const MESSAGES_BY_KIND: Record<string, Array<[number, string]>> = {
  export: [
    [0,  'Spinning up the export pipeline…'],
    [10, 'Fetching scene videos from storage…'],
    [22, 'Decoding scene clips…'],
    [38, 'Aligning narration tracks to scene boundaries…'],
    [55, 'Mixing music + SFX bed under the master…'],
    [70, 'Burning captions across every scene…'],
    [82, 'Final color pass + transcoding to H.264…'],
    [92, 'Writing the master file…'],
    [98, 'Almost there — encoding the last frames…'],
  ],
  'captions-apply': [
    [0,  'Pulling caption settings from the project…'],
    [10, 'Reading every scene narration…'],
    [25, 'Generating word-level timing from the audio…'],
    [45, 'Building the caption track…'],
    [65, 'Compiling ASS subtitle stream…'],
    [78, 'Burning captions into the master…'],
    [92, 'Wrapping up the new export…'],
  ],
  'voice-apply-all': [
    [0,  'Switching the project voice…'],
    [10, 'Queueing per-scene narration jobs…'],
    [25, 'TTS rendering scene voiceovers…'],
    [55, 'Re-synthesising every line in the new voice…'],
    [82, 'Writing the new audio tracks back to the timeline…'],
    [95, 'Almost done — finalising audio…'],
  ],
  'motion-apply-all': [
    [0,  'Re-queueing every scene with the new motion…'],
    [10, 'Booting up Kling V3.0 Pro renderers…'],
    [25, 'Generating fresh keyframes per scene…'],
    [55, 'Animating new camera motion across scenes…'],
    [80, 'Encoding new scene clips…'],
    [94, 'Stitching back into the timeline…'],
  ],
};

const TITLE_BY_KIND: Record<string, string> = {
  export: 'Exporting your full video',
  'captions-apply': 'Burning captions across every scene',
  'voice-apply-all': 'Applying voice + re-rendering every scene',
  'motion-apply-all': 'Re-rendering every scene with new motion',
};

function messageForProgress(kind: string, pct: number): string {
  const msgs = MESSAGES_BY_KIND[kind] ?? MESSAGES_BY_KIND.export;
  let msg = msgs[0][1];
  for (const [threshold, text] of msgs) {
    if (pct >= threshold) msg = text;
  }
  return msg;
}

function LoadingRing({ size = 92 }: { size?: number }) {
  return (
    <svg viewBox="0 0 50 50" width={size} height={size} aria-hidden="true">
      <circle cx="25" cy="25" r="20" fill="none" stroke="rgba(20,200,204,.12)" strokeWidth="3" />
      <circle
        cx="25" cy="25" r="20" fill="none"
        stroke="url(#bulkSg)" strokeWidth="3" strokeLinecap="round" strokeDasharray="50 200"
        transform="rotate(-90 25 25)"
      >
        <animateTransform attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="1.2s" repeatCount="indefinite" />
      </circle>
      <defs>
        <linearGradient id="bulkSg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#14C8CC" />
          <stop offset="100%" stopColor="#0FA6AE" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function formatElapsed(start: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function BulkOpModal({
  projectId,
}: {
  projectId: string | null | undefined;
}) {
  const { user } = useAuth();
  const { bulkOpActive, bulkOpKind, bulkOpProgress, bulkOpJobCount } =
    useActiveJobs(projectId ?? null);
  const [cancelling, setCancelling] = useState(false);

  // Track when the op started so we can show an elapsed counter. Reset
  // whenever the kind changes (different op started).
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Tick every second so the elapsed time updates.
  const [, tick] = useState(0);
  // Sticky open + monotonic display progress. Reasons:
  //   1. Hold the modal at "Done" for ~1.2s after the last job flips
  //      so users see completion instead of an instant disappear.
  //   2. Monotonic guard: bulkOpProgress can briefly drop when a new
  //      job in the batch comes in at 0% and pulls the average down
  //      — never let the displayed bar go backwards.
  const [forceShow, setForceShow] = useState(false);
  const [shownProgress, setShownProgress] = useState(0);

  useEffect(() => {
    if (bulkOpActive && !startedAt) setStartedAt(Date.now());
  }, [bulkOpActive, startedAt]);

  useEffect(() => {
    if (!bulkOpActive) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [bulkOpActive]);

  // Monotonic progress
  useEffect(() => {
    if (!bulkOpActive) return;
    setShownProgress((prev) => Math.max(prev, bulkOpProgress));
  }, [bulkOpActive, bulkOpProgress]);

  // Hold at 100% briefly after the bulk batch goes idle so the user
  // sees completion instead of a sudden disappear.
  useEffect(() => {
    if (bulkOpActive) {
      setForceShow(true);
      return;
    }
    if (!forceShow) return;
    setShownProgress(100);
    const t = setTimeout(() => {
      setForceShow(false);
      setStartedAt(null);
      setShownProgress(0);
    }, 1200);
    return () => clearTimeout(t);
  }, [bulkOpActive, forceShow]);

  // Block Esc + body scroll while the modal is mounted. Backdrop has
  // no onClick handler — clicks are absorbed but never close it.
  useEffect(() => {
    if (!forceShow) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault(); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey, true);
    };
  }, [forceShow]);

  if (!forceShow || !bulkOpKind) return null;

  // Cancel the active export. Marks every pending/processing
  // export_video job for this project as `failed` with a "Cancelled by
  // user" error_message — there's no `cancelled` value in the
  // chk_video_generation_jobs_status enum, so `failed` is the closest
  // valid terminal state. Two effects:
  //   • useActiveJobs requeries on the realtime UPDATE → bulkOpActive
  //     flips false → this modal dismisses.
  //   • EditorTopBar's useExport realtime handler sees status='failed'
  //     and sets exportState='error' → no auto-download fires.
  // The worker may still finish whatever ffmpeg invocation it's mid-way
  // through, but the UI is freed and credits already deducted are NOT
  // refunded here (refund logic lives in admin_cancel_job_with_refund;
  // user-initiated cancels currently forfeit credits the same way a
  // failed render does).
  const cancelExport = async () => {
    if (!user || !projectId || cancelling) return;
    setCancelling(true);
    try {
      const { error } = await supabase
        .from('video_generation_jobs')
        .update({
          status: 'failed',
          error_message: 'Cancelled by user',
        })
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .eq('task_type', 'export_video')
        .in('status', ['pending', 'processing']);
      if (error) throw error;
      toast.success('Export cancelled.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Cancel failed: ${msg}`);
      setCancelling(false);
    }
  };

  const title = TITLE_BY_KIND[bulkOpKind] ?? 'Project re-rendering';
  // Voice/audio operations don't have meaningful per-scene progress
  // (it's one Gemini call we can't peek into). Show the spinner +
  // status copy without a % bar — eliminates the "stuck at 2%"
  // confusion. Keep the bar for export + motion-apply-all where the
  // worker writes real per-job progress we can average.
  const showPercent = bulkOpKind === 'export' || bulkOpKind === 'motion-apply-all';
  const displayProgress = Math.max(0, Math.min(100, shownProgress));
  const message = messageForProgress(bulkOpKind, displayProgress);
  const isFinishing = !bulkOpActive;

  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center bg-black/85 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      aria-label={title}
    >
      <div className="relative w-[min(92vw,520px)] max-h-[90dvh] overflow-y-auto rounded-2xl border border-white/10 bg-gradient-to-b from-[#10151A] to-[#0A0D0F] p-7 sm:p-9 text-center shadow-[0_40px_120px_-30px_rgba(20,200,204,.45)]">
        <div
          className="absolute inset-0 pointer-events-none rounded-2xl opacity-[0.05]"
          style={{
            backgroundImage: 'radial-gradient(rgba(255,255,255,.7) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none rounded-2xl"
          style={{
            background:
              'radial-gradient(60% 80% at 50% 0%, rgba(20,200,204,.18), transparent 70%)',
          }}
        />

        <div className="relative flex flex-col items-center gap-4">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#E4C875]/10 border border-[#E4C875]/30 font-mono text-[9px] tracking-[0.16em] uppercase text-[#E4C875]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#E4C875] animate-pulse" />
            REC · {startedAt ? formatElapsed(startedAt) : '00:00'}
          </div>

          <LoadingRing size={84} />

          <div className="font-serif text-[20px] sm:text-[24px] font-medium text-[#ECEAE4] leading-tight">
            {title}
          </div>

          {showPercent && (
            <div className="w-full max-w-[420px] mt-1">
              <div className="h-[3px] rounded-full bg-white/[0.08] overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#14C8CC] to-[#0FA6AE] rounded-full transition-[width] duration-700"
                  style={{ width: `${displayProgress}%` }}
                />
              </div>
              <div className="flex items-center justify-between mt-2 font-mono text-[11px] tracking-[0.14em] uppercase">
                <span className="text-[#14C8CC]">{displayProgress}%</span>
                {bulkOpJobCount > 1 && (
                  <span className="text-[#5A6268]">{bulkOpJobCount} parallel jobs</span>
                )}
              </div>
            </div>
          )}

          <div className="font-serif italic text-[13px] sm:text-[14px] text-[#8A9198] text-center max-w-[90%] min-h-[40px] leading-[1.55]">
            {isFinishing ? 'Wrapping up — saving the new audio…' : message}
          </div>

          <div className="font-mono text-[9.5px] tracking-[0.14em] uppercase text-[#5A6268] mt-1">
            {bulkOpKind === 'export'
              ? 'Your file will download as soon as encoding finishes'
              : 'Editing is locked while this finishes'}
          </div>

          {/* Cancel — only on export jobs and only while the worker
              is still active. Once bulkOpActive flips false (job
              completed or failed) the modal is in its 1.2s wrap-up
              hold and a Cancel click would be misleading. */}
          {bulkOpKind === 'export' && bulkOpActive && (
            <button
              type="button"
              onClick={cancelExport}
              disabled={cancelling}
              className="mt-3 inline-flex items-center justify-center px-4 py-2 rounded-md font-mono text-[10.5px] tracking-[0.14em] uppercase border border-white/10 text-[#8A9198] hover:text-[#ECEAE4] hover:border-white/20 hover:bg-white/[0.03] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {cancelling ? 'Cancelling…' : 'Cancel export'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
