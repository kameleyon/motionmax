/** Minimal save-status event bus for the Editor.
 *
 *  C-3-1: The Editor's autosave chip (top bar) was previously hardcoded
 *  to `'saved'`, so users got a misleading green "Auto-saved" pill even
 *  while writes were failing — silent data loss. The persistence calls
 *  (scene meta, voice, language, intake settings, captions) all live in
 *  the `useSceneRegen` hook called from <Inspector>; the chip lives on
 *  the EditorTopBar, called from the Editor page. Rather than refactor
 *  the entire props tree, we publish save events to this tiny module-
 *  scoped bus and the Editor page subscribes for the chip.
 *
 *  This is intentionally NOT a React Context — Inspector and Editor are
 *  in the same React tree, but the bus also lets future non-Inspector
 *  saves (e.g. direct Stage edits, drag-to-reorder in Timeline) plug in
 *  without threading callbacks. Single-instance Editor page guarantees
 *  no cross-talk between two open tabs (each tab owns its own JS realm).
 */

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type Listener = (status: SaveStatus) => void;

let current: SaveStatus = 'idle';
const listeners = new Set<Listener>();
let savedTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: SaveStatus): void {
  current = next;
  for (const fn of listeners) fn(next);
}

/** Mark a save as in-flight. Cancels any pending "saved → idle" decay. */
export function notifySaving(): void {
  if (savedTimer) {
    clearTimeout(savedTimer);
    savedTimer = null;
  }
  emit('saving');
}

/** Mark a save as completed successfully. After 2s with no further
 *  activity the chip returns to 'idle' so it doesn't sit perpetually
 *  green like the old hardcoded value. */
export function notifySaved(): void {
  if (savedTimer) clearTimeout(savedTimer);
  emit('saved');
  savedTimer = setTimeout(() => {
    if (current === 'saved') emit('idle');
    savedTimer = null;
  }, 2000);
}

/** Mark a save as failed. Stays sticky until the next save attempt —
 *  silent data loss is exactly what we're guarding against here. */
export function notifySaveError(): void {
  if (savedTimer) {
    clearTimeout(savedTimer);
    savedTimer = null;
  }
  emit('error');
}

/** Subscribe to save-status transitions. Returns an unsubscribe fn.
 *  The listener is fired immediately with the current status so the
 *  consumer doesn't sit on a stale default. */
export function subscribeSaveStatus(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test-only — wipe the bus between cases. Not exported from index. */
export function __resetSaveStatusForTests(): void {
  if (savedTimer) {
    clearTimeout(savedTimer);
    savedTimer = null;
  }
  current = 'idle';
  listeners.clear();
}
