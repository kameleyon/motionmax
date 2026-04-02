import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

/**
 * Forces dark mode while the consuming component is mounted.
 * Restores the previous theme on unmount so authenticated pages
 * keep whichever theme the user had selected.
 */
export function useForceDarkMode() {
  const { setTheme, theme } = useTheme();
  const previousThemeRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Capture the theme that was active before we override it
    previousThemeRef.current = theme;
    setTheme("dark");

    return () => {
      // Restore whatever the user had before visiting this page
      const prev = previousThemeRef.current;
      if (prev && prev !== "dark") {
        setTheme(prev);
      }
    };
    // Run only on mount / unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
