import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { THEME_CHANGE_EVENT } from "../../lib/theme";

const documentTheme = (): ToasterProps["theme"] =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = useState<ToasterProps["theme"]>(documentTheme);

  useEffect(() => {
    const sync = () => setTheme(documentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => {
      observer.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
    };
  }, []);

  return (
    <Sonner
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          "--width": "min(420px, calc(100vw - 32px))",
        } as CSSProperties
      }
      theme={theme}
      {...props}
    />
  );
};

export { Toaster };
