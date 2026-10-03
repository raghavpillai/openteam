import { useEffect, useState } from "react";
import { subscribeDayClock } from "../lib/day-clock";

export function useDayClock(active: boolean) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (active) return subscribeDayClock(setNow);
  }, [active]);
  return now;
}
