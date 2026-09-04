"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Reveals its children once they scroll into view. The visual work lives in
 * globals.css under `[data-motion] [data-reveal]`; this only flips `data-in`.
 * Without the `data-motion` flag (reduced motion, or no JS) nothing is hidden.
 */
export function Reveal({
  as = "div",
  className,
  stagger = 0,
  delay = 0,
  children,
  ...rest
}: {
  as?: "div" | "ul" | "ol" | "section";
  className?: string;
  /** Milliseconds between each direct child. Children set `--i` to order themselves. */
  stagger?: number;
  /** Extra delay before the first child moves. */
  delay?: number;
  children: ReactNode;
} & Record<`aria-${string}`, string | undefined>) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const motion = document.documentElement.hasAttribute("data-motion");
    if (!motion || !("IntersectionObserver" in window)) {
      el.setAttribute("data-in", "");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.setAttribute("data-in", "");
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The union of tags is a runtime detail; type it as a div so the ref stays simple.
  const Tag = as as "div";
  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      data-reveal=""
      className={className}
      style={{ "--stagger": `${stagger}ms`, "--reveal-delay": `${delay}ms` } as CSSProperties}
      {...rest}
    >
      {children}
    </Tag>
  );
}
