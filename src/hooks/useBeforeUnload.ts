import { useEffect } from 'react';

/**
 * G-M8 (Ghost): browser-level prompt when the user tries to navigate
 * away (close tab, refresh, hit back) while critical work is in flight.
 *
 * Pass `enabled=true` while a project insert, export, or any other
 * non-resumable mutation is queued + the worker is still processing.
 * The browser will show its built-in "Reload site? Changes you made
 * may not be saved" dialog. We don't get to customise the copy
 * (modern browsers ignore the message string for anti-phishing
 * reasons), but the dialog itself fires.
 *
 * Usage:
 *   useBeforeUnload(
 *     exportState.status === 'submitting' || exportState.status === 'rendering',
 *     'Your export is still rendering — leaving now will keep the job running on the server.',
 *   );
 *
 * Why this matters: an in-flight `startExport` does an INSERT and
 * then attaches a realtime channel. If the user navigates between
 * those two awaits, the INSERT lands but no client is listening for
 * the worker's progress / completion, so the editor on next return
 * looks idle even though the job is alive. The prompt lets the user
 * make an informed decision instead of accidentally walking away.
 */
export function useBeforeUnload(enabled: boolean, message?: string) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Some older browsers (Safari historically) read the return
      // value; Chrome/Firefox ignore it but still show the prompt.
      e.returnValue = message ?? '';
      return message ?? '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled, message]);
}
