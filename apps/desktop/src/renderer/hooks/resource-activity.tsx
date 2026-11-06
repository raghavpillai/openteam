import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useWindowVisible } from "./use-window-active";

const ResourceActivity = createContext(true);
export const useResourceActive = () => useContext(ResourceActivity);

/** Retain expensive presentation briefly so quick view switches stay warm. */
export function ResourceActivityProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const parentActive = useResourceActive();
  const [retained, setRetained] = useState(active);
  useEffect(() => {
    if (active) {
      setRetained(true);
      return;
    }
    const timer = window.setTimeout(() => setRetained(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [active]);
  return (
    <ResourceActivity value={parentActive && (active || retained)}>{children}</ResourceActivity>
  );
}

export function WindowResourceActivity({ children }: { children: ReactNode }) {
  const visible = useWindowVisible();
  return <ResourceActivityProvider active={visible}>{children}</ResourceActivityProvider>;
}
