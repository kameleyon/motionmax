import { useEffect, useRef, useCallback } from "react";

const DRAFT_PREFIX = "motionmax_draft_";
const AUTO_SAVE_INTERVAL_MS = 10_000;

/**
 * Auto-saves workspace form state to localStorage every 10 seconds.
 * Returns helpers to load saved draft and clear it.
 */
export function useWorkspaceDraft<T extends Record<string, unknown>>(
  mode: string,
  currentState: T,
  isIdle: boolean
) {
  const storageKey = `${DRAFT_PREFIX}${mode}`;
  const stateRef = useRef(currentState);
  stateRef.current = currentState;

  // Auto-save every 10s while user is on the idle form
  useEffect(() => {
    if (!isIdle) return;

    const timer = setInterval(() => {
      try {
        const serialized = JSON.stringify(stateRef.current);
        localStorage.setItem(storageKey, serialized);
      } catch {
        // Storage full or serialization issue — silently skip
      }
    }, AUTO_SAVE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [storageKey, isIdle]);

  const loadDraft = useCallback((): T | null => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }, [storageKey]);

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Ignore
    }
  }, [storageKey]);

  const hasDraft = useCallback((): boolean => {
    try {
      return localStorage.getItem(storageKey) !== null;
    } catch {
      return false;
    }
  }, [storageKey]);

  return { loadDraft, clearDraft, hasDraft };
}
