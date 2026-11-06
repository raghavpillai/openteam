import { useEffect, useState } from "react";
import { useWindowVisible } from "./use-window-active";
import { useResourceActive } from "./resource-activity";

/** UI clocks catch up on resume without waking a hidden renderer. */
export function useVisibleNow(intervalMs: number, enabled = true) {
  const visible = useWindowVisible();
  const resourcesActive = useResourceActive();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || !enabled || !resourcesActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, visible, resourcesActive]);
  return now;
}
