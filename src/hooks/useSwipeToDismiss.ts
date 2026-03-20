import { useRef, useCallback, type TouchEvent } from "react";

/* ──────────────────────────────────────────────
 * useSwipeToDismiss — detect horizontal swipe
 * gestures and call `onDismiss` when the user
 * swipes in the expected direction.
 *
 * Usage:
 *   const handlers = useSwipeToDismiss({
 *     direction: "left",  // sidebar on the left → swipe left to close
 *     onDismiss: () => setOpen(false),
 *   });
 *   <div {...handlers}>…</div>
 * ────────────────────────────────────────────── */

interface SwipeOptions {
  /** Swipe direction that triggers dismiss */
  direction: "left" | "right";
  /** Called when a qualifying swipe is detected */
  onDismiss: () => void;
  /** Minimum horizontal distance (px) to qualify as a swipe. Default: 60 */
  threshold?: number;
}

export function useSwipeToDismiss({ direction, onDismiss, threshold = 60 }: SwipeOptions) {
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);

  const onTouchStart = useCallback((e: TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (startX.current === null || startY.current === null) return;

      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const dx = endX - startX.current;
      const dy = Math.abs(endY - startY.current);

      // Only trigger if horizontal movement exceeds threshold
      // and horizontal distance is greater than vertical (not a scroll)
      const isHorizontal = Math.abs(dx) > dy;
      const meetsThreshold = Math.abs(dx) >= threshold;

      if (isHorizontal && meetsThreshold) {
        if (direction === "left" && dx < 0) {
          onDismiss();
        } else if (direction === "right" && dx > 0) {
          onDismiss();
        }
      }

      startX.current = null;
      startY.current = null;
    },
    [direction, onDismiss, threshold],
  );

  return { onTouchStart, onTouchEnd };
}
