import { useEffect, useState } from "react";

const SIDEBAR_STATE_KEY = "motionmax-sidebar-state";
const LEGACY_SIDEBAR_STATE_KEY = "audiomax-sidebar-state";

export function useSidebarState() {
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const stored =
        localStorage.getItem(SIDEBAR_STATE_KEY) ??
        localStorage.getItem(LEGACY_SIDEBAR_STATE_KEY);
      return stored !== null ? JSON.parse(stored) : true;
    }
    return true;
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(isOpen));
    // Best-effort cleanup.
    try {
      localStorage.removeItem(LEGACY_SIDEBAR_STATE_KEY);
    } catch {
      // ignore
    }
  }, [isOpen]);

  const toggle = () => setIsOpen((prev) => !prev);
  const open = () => setIsOpen(true);
  const close = () => setIsOpen(false);

  return { isOpen, setIsOpen, toggle, open, close };
}
