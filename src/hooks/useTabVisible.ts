import { useEffect, useState } from 'react';

/**
 * Returns true while the document is visible (foreground tab) and false
 * when it's hidden (background tab, minimised window, screen off, etc.).
 *
 * Use this to gate `refetchInterval` on `useQuery` so polling pauses
 * when nobody's looking — saves API quota, battery, and avoids the
 * 60s/10s dashboard fan-out hammering Supabase from a stale tab.
 *
 * Wired into:
 *   - GenerationQueueStatus (10s poll)
 *   - useSubscription (60s poll)
 *   - any future polling query that doesn't need to run in background
 *
 * Why a hook (vs. just relying on `refetchIntervalInBackground: false`):
 *   @tanstack/react-query's flag honours the visibility state at the
 *   moment of each scheduled tick, but the timer still keeps firing
 *   on the timeline. The difference is small in practice, but using
 *   `enabled` / conditional `refetchInterval` removes the timer
 *   entirely while hidden, which is cleaner under React DevTools and
 *   matches the audit's recommendation (C-5-6 PERF-010).
 *
 * SSR-safe: returns `true` on the server / before mount so the first
 * render doesn't disable a polling query that should be active by the
 * time the page is interactive.
 */
export function useTabVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    // Sync once on mount in case the document.visibilityState changed
    // between the initial useState read and effect attachment (rare but
    // possible during fast tab switches at app boot).
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

export default useTabVisible;
