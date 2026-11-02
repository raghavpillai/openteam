import { useEffect, useState } from "react";
import type { BrowserNetworkView } from "@openteam/contracts/browser-network";
import { api } from "../../client/openteam-api";
import { browserNetworkLabel } from "../../lib/browser-network-status";

export function BrowserNetworkIndicator() {
  const [view, setView] = useState<BrowserNetworkView | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      void api
        .browserNetwork()
        .then((value) => {
          if (active) setView(value);
        })
        .catch(() => {
          if (active)
            setView((current) =>
              current ? { ...current, runtime: { ...current.runtime, state: "unavailable" } } : null
            );
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return view ? (
    <div
      role="status"
      className="pointer-events-none absolute bottom-2 left-2 z-20 max-w-[90%] rounded bg-background/95 px-2 py-1 text-[11px] text-foreground-secondary"
    >
      {browserNetworkLabel(view)}
    </div>
  ) : null;
}
