"use client";

import { useEffect, useRef } from "react";

/** Small, once-only reveals. Reading surfaces and layout never move on scroll. */
export function LandingEffects() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(".landing");
    if (!root || !("IntersectionObserver" in window)) return;
    const html = document.documentElement;
    const played = new WeakSet<Element>();
    const animations = new Set<Animation>();
    let observer: IntersectionObserver | undefined;
    // Retire the removed page-level pause preference, including already-open previews.
    html.removeAttribute("data-motion-paused");
    try { localStorage.removeItem("openteam-motion-paused"); } catch { /* Storage is optional. */ }
    const targets = root.querySelectorAll<HTMLElement>(
      ".ot-section-heading h2, .ot-feature-copy h2, .ot-scene-copy h2, .ot-ownership h2, .dl-step-heading h2",
    );
    const sync = () => {
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || played.has(entry.target)) return;
          played.add(entry.target);
          observer?.unobserve(entry.target);
          // Anchor jumps and restored scroll positions should show finished content.
          if (entry.boundingClientRect.top < 140) return;
          const animation = entry.target.animate([
            { clipPath: "inset(0 0 100% 0)" },
            { clipPath: "inset(0 0 0% 0)" },
          ], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" });
          animations.add(animation);
          animation.onfinish = () => animations.delete(animation);
        });
      }, { threshold: 0, rootMargin: "0px 0px 80px 0px" });
      targets.forEach((target) => { if (!played.has(target)) observer?.observe(target); });
    };
    const visibility = () => {
      html.toggleAttribute("data-page-hidden", document.hidden);
      animations.forEach((animation) => document.hidden ? animation.pause() : animation.play());
    };
    const ambient = new IntersectionObserver((entries) => {
      entries.forEach((entry) => entry.target.toggleAttribute("data-motion-visible", entry.isIntersecting));
    });
    const scenes = new IntersectionObserver((entries) => {
      entries.forEach((entry) => entry.target.toggleAttribute("data-scene-visible", entry.isIntersecting));
    }, { threshold: 0.1 });
    root.querySelectorAll("main > section").forEach((section) => scenes.observe(section));
    if (ref.current) ambient.observe(ref.current);
    sync();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer?.disconnect();
      ambient.disconnect();
      scenes.disconnect();
      animations.forEach((animation) => animation.cancel());
      document.removeEventListener("visibilitychange", visibility);
      html.removeAttribute("data-page-hidden");
    };
  }, []);
  return (
    <div ref={ref} className="ot-grid-backdrop" aria-hidden="true">
      <span className="ot-grid-signal ot-grid-signal-a" />
      <span className="ot-grid-signal ot-grid-signal-b" />
    </div>
  );
}
