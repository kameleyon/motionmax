import { useEffect } from 'react';

/** Project-theme replacement for window.confirm() on the bulk-apply
 *  buttons (voice apply-all, motion re-render-all). Matches BulkOpModal's
 *  look so the transition from "confirm?" → "rendering…" feels like one
 *  continuous modal instead of a browser popup then a styled one.
 *
 *  Intentionally NOT dismissable by clicking the backdrop or hitting Esc
 *  — the operations it gates are expensive (up to N parallel jobs) so we
 *  want an explicit Cancel click, not an accidental outside-click. */

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** Plain text or multi-line; rendered as italic serif paragraph. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shown as an uppercase mono footer below the buttons — mirrors
   *  BulkOpModal's "EDITING IS LOCKED WHILE THIS FINISHES" strip so the
   *  user knows what they're about to agree to. */
  footer?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  footer,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Lock page scroll while open so users can't scroll the editor behind
  // the modal — matches BulkOpModal behaviour.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center bg-black/80 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="relative w-[min(92vw,520px)] rounded-2xl border border-white/10 bg-gradient-to-b from-[#10151A] to-[#0A0D0F] p-7 sm:p-9 text-center shadow-[0_40px_120px_-30px_rgba(20,200,204,.45)]">
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
            <span className="w-1.5 h-1.5 rounded-full bg-[#E4C875]" />
            Confirm
          </div>

          <div className="font-serif text-[20px] sm:text-[24px] font-medium text-[#ECEAE4] leading-tight max-w-[90%]">
            {title}
          </div>

          <div className="font-serif italic text-[13px] sm:text-[14px] text-[#8A9198] text-center max-w-[92%] leading-[1.55]">
            {message}
          </div>

          <div className="flex items-center justify-center gap-3 mt-2">
            <button
              type="button"
              onClick={onCancel}
              className="min-w-[120px] px-5 py-2.5 rounded-full text-[12.5px] font-semibold text-[#ECEAE4] border border-white/15 bg-white/[0.03] hover:bg-white/[0.08] hover:border-white/25 transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              autoFocus
              className="min-w-[120px] px-5 py-2.5 rounded-full text-[12.5px] font-semibold text-[#0A0D0F] bg-gradient-to-r from-[#14C8CC] via-[#0FA6AE] to-[#14C8CC] hover:brightness-105 shadow-[0_8px_24px_-8px_rgba(20,200,204,.6)]"
            >
              {confirmLabel}
            </button>
          </div>

          {footer && (
            <div className="font-mono text-[9.5px] tracking-[0.14em] uppercase text-[#5A6268] mt-1">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
