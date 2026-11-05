import { useEffect, useState } from "react";
import { subscribeDayClock } from "../lib/day-clock";
import { useWindowVisible } from "./use-window-active";

export function useDayClock(active: boolean) {
  const visible = useWindowVisible();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (active && visible) return subscribeDayClock(setNow);
  }, [active, visible]);
  return now;
}
