"use client";

import { useEffect, useRef } from "react";
import { BotAvatar } from "./bot-avatar";

/** Decorative grid and progressive, once-per-section entrance motion. */
export function LandingEffects() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current?.closest(".landing");
    if (!root || !("IntersectionObserver" in window)) return;

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const played = new WeakSet<Element>();
    const animations = new Set<Animation>();
    let observer: IntersectionObserver | undefined;
    const targets = root.querySelectorAll<HTMLElement>(
      ".ot-providers, .ot-section-heading, .pl-demo, .ot-job, .ot-computer-row, " +
        ".ot-persistence-grid, .ot-small-features > div, .ot-anywhere-copy, .dm-mobile-scene, " +
        ".ot-ownership > div, .ot-start, .ot-faq, .dl-step",
    );

    const sync = () => {
      observer?.disconnect();
      if (preference.matches) {
        animations.forEach((animation) => animation.cancel());
        animations.clear();
        return;
      }
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry, index) => {
            if (!entry.isIntersecting || played.has(entry.target)) return;
            played.add(entry.target);
            observer?.unobserve(entry.target);
            const animation = entry.target.animate(
              [
                { opacity: 0, transform: "translateY(18px)" },
                { opacity: 1, transform: "translateY(0)" },
              ],
              {
                duration: 650,
                delay: Math.min(index, 3) * 60,
                easing: "cubic-bezier(.22,1,.36,1)",
                fill: "both",
              },
            );
            animations.add(animation);
            animation.onfinish = () => {
              animation.cancel();
              animations.delete(animation);
            };
          });
        },
        { threshold: 0.06, rootMargin: "0px 0px -32px 0px" },
      );
      targets.forEach((target) => {
        if (!played.has(target)) observer?.observe(target);
      });
    };

    sync();
    preference.addEventListener("change", sync);
    return () => {
      observer?.disconnect();
      animations.forEach((animation) => animation.cancel());
      preference.removeEventListener("change", sync);
    };
  }, []);

  return (
    <>
      <div ref={ref} className="ot-grid-backdrop" aria-hidden="true" />
      <div className="ot-margin-bots" aria-hidden="true">
        <span className="ot-margin-bot ot-margin-bot-research">
          <BotAvatar shape="helmet" color="#ff7a1a" size={76} mode="idle" />
        </span>
        <span className="ot-margin-bot ot-margin-bot-operations">
          <BotAvatar shape="pod" color="#925df2" size={64} mode="idle" blinkDelay={900} />
        </span>
        <span className="ot-margin-bot ot-margin-bot-engineering">
          <BotAvatar shape="chip" color="#27baae" size={52} mode="idle" blinkDelay={1800} />
        </span>
      </div>
    </>
  );
}
