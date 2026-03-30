import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Animated route outlet that provides fade transitions between pages.
 * Wraps React Router's Outlet with AnimatePresence for smooth page changes.
 *
 * Uses useOutlet() (which returns the current element) + location.key
 * to trigger exit/enter animations on route changes.
 */
export function AnimatedOutlet() {
  const location = useLocation();
  const outlet = useOutlet();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2, ease: "easeInOut" }}
        className="flex-1 min-w-0"
      >
        {outlet}
      </motion.div>
    </AnimatePresence>
  );
}
