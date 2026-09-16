"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

/** Demos start on approach and keep playing through hover, focus, and selection. */
export function useDemoCycle(
  count: number,
  interval: number | readonly number[] = 6000,
  enabled = true
) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(false);
  const duration = typeof interval === "number" ? interval : interval[index % interval.length];
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = false;
    const sync = () => {
      setVisible(intersecting && !document.hidden);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry.isIntersecting;
        sync();
      },
      { threshold: 0.01, rootMargin: "100px 0px" }
    );
    observer.observe(element);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  const playing = visible && enabled;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setIndex((current) => (current + 1) % count), duration);
    return () => window.clearTimeout(timer);
  }, [count, duration, index, playing, revision]);
  const select = (next: number) => {
    setIndex(next);
    setRevision((current) => current + 1);
  };
  return {
    ref,
    index,
    select,
    playing,
    revision,
    props: {
      "data-playing": playing,
      style: { "--cycle-duration": `${duration}ms` } as CSSProperties,
    },
  };
}
