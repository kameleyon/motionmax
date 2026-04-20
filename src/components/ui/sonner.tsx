import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/** Detect if the document currently has force-dark applied (data-theme="dark" on <html>) */
function useForcedDarkDetect() {
  const [forceDark, setForceDark] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setForceDark(el.getAttribute("data-theme") === "dark" || el.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);
  return forceDark;
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const forceDark = useForcedDarkDetect();
  const resolvedTheme = forceDark ? "dark" : (theme as ToasterProps["theme"]);

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
