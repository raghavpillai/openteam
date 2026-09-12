"use client";

import { Pause, Play } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener("openteam:motion-preference", callback);
  media.addEventListener("change", callback);
  return () => {
    window.removeEventListener("openteam:motion-preference", callback);
    media.removeEventListener("change", callback);
  };
}

export function MotionToggle() {
  const paused = useSyncExternalStore(subscribe, () => document.documentElement.hasAttribute("data-motion-paused"), () => false);
  const reduced = useSyncExternalStore(subscribe, () => matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
  const label = reduced ? "Animations paused by system preference" : paused ? "Resume animations" : "Pause animations";
  return (
    <button
      type="button"
      className="ot-motion-toggle"
      title={label}
      aria-label={label}
      aria-pressed={paused || reduced}
      disabled={reduced}
      onClick={() => {
        document.documentElement.toggleAttribute("data-motion-paused", !paused);
        try { localStorage.setItem("openteam-motion-paused", String(!paused)); } catch { /* Private browsing can disable storage. */ }
        window.dispatchEvent(new Event("openteam:motion-preference"));
      }}
    >
      {paused || reduced ? <Play size={14} /> : <Pause size={14} />}
    </button>
  );
}
