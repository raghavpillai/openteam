"use client";

import { useEffect, useRef } from "react";

/** Progressive entrances and a quiet, responsive grid; content is visible without JS. */
export function LandingEffects() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = ref.current;
    const root = grid?.closest<HTMLElement>(".landing");
    if (!root || !grid || !("IntersectionObserver" in window)) return;
    const html = document.documentElement;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const played = new WeakSet<Element>();
    const animations = new Set<Animation>();
    let observer: IntersectionObserver | undefined;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    try { html.toggleAttribute("data-motion-paused", localStorage.getItem("openteam-motion-paused") === "true"); } catch { /* Storage is optional. */ }
    window.dispatchEvent(new Event("openteam:motion-preference"));

    const targets = root.querySelectorAll<HTMLElement>(
      ".ot-section-heading > *, .ot-proof-strip > a, .ot-job, .ot-team-steps > li, " +
      ".pl-demo, .ot-plugin-points > article, .ot-worker-tabs, .ot-ownership > div, " +
      ".ot-ownership-providers, .ot-start, .ot-faq, .dl-step-heading, .dl-step-content",
    );
    const allowed = () => !preference.matches && !html.hasAttribute("data-motion-paused");
    const sync = () => {
      observer?.disconnect();
      if (!allowed()) {
        animations.forEach((animation) => animation.cancel());
        animations.clear();
        return;
      }
      observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, index) => {
          if (!entry.isIntersecting || played.has(entry.target)) return;
          played.add(entry.target);
          observer?.unobserve(entry.target);
          const animation = entry.target.animate([
            { opacity: 0.35, transform: "translateY(28px)" },
            { opacity: 1, transform: "translateY(0)" },
          ], { duration: 760, delay: Math.min(index, 3) * 85, easing: "cubic-bezier(.16,1,.3,1)", fill: "both" });
          animations.add(animation);
          animation.onfinish = () => { animation.cancel(); animations.delete(animation); };
        });
      }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
      targets.forEach((target) => { if (!played.has(target)) observer?.observe(target); });
    };
    const visibility = () => {
      html.toggleAttribute("data-page-hidden", document.hidden);
      animations.forEach((animation) => document.hidden ? animation.pause() : animation.play());
    };
    const ambient = new IntersectionObserver((entries) => {
      entries.forEach((entry) => entry.target.toggleAttribute("data-motion-visible", entry.isIntersecting));
    });
    root.querySelectorAll(".ot-grid-backdrop, .ot-section-bot").forEach((target) => ambient.observe(target));
    const pointer = (event: PointerEvent) => {
      if (!allowed() || event.pointerType !== "mouse" || !grid.hasAttribute("data-motion-visible")) return;
      const bounds = grid.getBoundingClientRect();
      pointerX = event.clientX - bounds.left;
      pointerY = event.clientY - bounds.top;
      if (!frame) frame = requestAnimationFrame(() => {
        grid.style.setProperty("--grid-x", `${pointerX}px`);
        grid.style.setProperty("--grid-y", `${pointerY}px`);
        frame = 0;
      });
    };
    sync();
    visibility();
    preference.addEventListener("change", sync);
    window.addEventListener("openteam:motion-preference", sync);
    document.addEventListener("visibilitychange", visibility);
    root.addEventListener("pointermove", pointer, { passive: true });
    return () => {
      observer?.disconnect();
      ambient.disconnect();
      animations.forEach((animation) => animation.cancel());
      cancelAnimationFrame(frame);
      preference.removeEventListener("change", sync);
      window.removeEventListener("openteam:motion-preference", sync);
      document.removeEventListener("visibilitychange", visibility);
      root.removeEventListener("pointermove", pointer);
      html.removeAttribute("data-page-hidden");
    };
  }, []);

  return (
    <div ref={ref} className="ot-grid-backdrop" aria-hidden="true">
      <div className="ot-grid-glow" />
      <span className="ot-grid-signal ot-grid-signal-a" />
      <span className="ot-grid-signal ot-grid-signal-b" />
      <span className="ot-grid-signal ot-grid-signal-c" />
    </div>
  );
}
