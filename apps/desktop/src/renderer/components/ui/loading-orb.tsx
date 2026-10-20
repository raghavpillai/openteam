import { useEffect, useState, useSyncExternalStore } from "react";
import type { OrbSize, ThinkingOrbProps } from "thinking-orbs";
import { cn } from "../../lib/cn";

// Startup screens show orbs, so the library loads on first use instead of
// joining the startup closure. Until it resolves, an empty box holds the space.
type OrbModule = typeof import("thinking-orbs");
let orbModule: OrbModule | undefined;
let orbModuleLoad: Promise<OrbModule> | undefined;
export const preloadLoadingOrb = () =>
  (orbModuleLoad ??= import("thinking-orbs").then((loaded) => (orbModule = loaded)));

// One orb for every loading state, matching the iOS app.
const ORB_STATE = "composing";
// 20, 32 and 64 are the library's tuned designs; other sizes scale the nearest
// one. Below 17 px the dots thicken as the orb shrinks so it stays readable.
const presetFor = (size: number): OrbSize => (size < 26 ? 20 : size < 48 ? 32 : 64);
const dotSizeFor = (size: number) => (size <= 16 ? 1.3 + (16 - size) * 0.1 : 1);

// The app keeps its resolved theme on <html data-theme>.
const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
const subscribeToNothing = () => () => undefined;
const documentIsDark = () => document.documentElement.dataset.theme === "dark";

export type LoadingOrbProps = Omit<ThinkingOrbProps, "aria-label" | "dotSize" | "size" | "state"> & {
  /** Rendered size in CSS pixels. */
  size?: number;
  /** Accessible name. */
  label?: string;
  /** Sits on an inverted fill (black in light mode, white in dark mode). */
  inverse?: boolean;
};

export function LoadingOrb({
  className,
  inverse = false,
  label = "Loading",
  size = 20,
  style,
  theme = "auto",
  ...props
}: LoadingOrbProps) {
  const [loaded, setLoaded] = useState(orbModule);
  useEffect(() => {
    if (!loaded) void preloadLoadingOrb().then(setLoaded);
  }, [loaded]);
  const dark = useSyncExternalStore(
    inverse ? subscribeToTheme : subscribeToNothing,
    documentIsDark
  );
  if (!loaded) {
    return (
      <span
        aria-hidden="true"
        className={cn("block shrink-0", className)}
        style={{ width: size, height: size, ...style }}
      />
    );
  }
  const { ThinkingOrb } = loaded;
  return (
    <ThinkingOrb
      {...props}
      aria-label={label}
      className={cn("shrink-0", className)}
      dotSize={dotSizeFor(size)}
      size={presetFor(size)}
      state={ORB_STATE}
      style={{ width: size, height: size, ...style }}
      theme={inverse ? (dark ? "light" : "dark") : theme}
    />
  );
}
