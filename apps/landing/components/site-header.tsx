"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { GithubMark, Wordmark } from "./brand";
import { Button } from "./ui/button";
import "./site-header.css";

const GITHUB = "https://github.com/raghavpillai/openteam";
const links = [
  ["Workers", "use-cases"],
  ["Computer", "capabilities"],
  ["Apps", "plugins"],
  ["Memory", "memory"],
  ["Routines", "routines"],
  ["Mobile", "mobile"],
];

export function SiteHeader({ home = false }: { home?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const menuAnimation = useRef<Animation | null>(null);
  const menuExpanded = useRef(false);
  const [current, setCurrent] = useState("");
  const setMenuOpen = useCallback((open: boolean) => {
    const details = menu.current;
    const panel = details?.querySelector("nav");
    if (!details || !panel || open === menuExpanded.current) return;

    // Capture the current frame before cancelling so quick toggles reverse smoothly.
    const style = getComputedStyle(panel);
    const closed = { opacity: 0, transform: "translateY(-8px) scale(.98)" };
    const from = details.open ? { opacity: style.opacity, transform: style.transform } : closed;
    menuAnimation.current?.cancel();
    menuExpanded.current = open;
    details.open = true;
    panel.inert = !open;
    const animation = panel.animate(
      [from, open ? { opacity: 1, transform: "translateY(0) scale(1)" } : closed],
      { duration: open ? 260 : 190, easing: "cubic-bezier(.22,1,.36,1)" },
    );
    menuAnimation.current = animation;
    animation.onfinish = () => {
      if (menuAnimation.current !== animation) return;
      details.open = open;
      menuAnimation.current = null;
    };
  }, []);
  useEffect(() => {
    if (!home) return;
    const sections = links.map(([, id]) => document.getElementById(id));
    let frame = 0;
    const update = () => {
      frame = 0;
      const readingLine = Math.max(100, window.innerHeight * 0.25);
      const section = sections.find((element) => {
        if (!element) return false;
        const bounds = element.getBoundingClientRect();
        return bounds.top <= readingLine && bounds.bottom > readingLine;
      });
      setCurrent(section?.id ?? "");
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [home]);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuExpanded.current) {
        event.preventDefault();
        setMenuOpen(false);
        menu.current?.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      menuAnimation.current?.cancel();
    };
  }, [setMenuOpen]);
  const prefix = home ? "" : "/";
  return (
    <header className="ot-header ot-site-header">
      <div className="ot-container ot-nav">
        <a href={home ? "#top" : "/"} aria-label="OpenTeam home" className="ot-wordmark">
          <Wordmark size={36} textSize={24} animated />
        </a>
        <nav aria-label="Main navigation" className="ot-nav-links">
          {links.map(([label, id]) => (
            <a href={`${prefix}#${id}`} key={id} aria-current={current === id ? "location" : undefined}>
              {label}
            </a>
          ))}
          <Link href="/docs">Docs</Link>
        </nav>
        <div className="ot-nav-actions">
          <a className="ot-github" href={GITHUB} aria-label="OpenTeam on GitHub">
            <GithubMark />
            <span>GitHub</span>
          </a>
          <Button
            className="ot-button"
            render={<a href={home ? "/download" : "#server"} />}
            nativeButton={false}
          >
            Install <ArrowUpRight size={15} />
          </Button>
        </div>
        <details className="ot-mobile-menu" ref={menu}>
          <summary onClick={(event) => {
            event.preventDefault();
            setMenuOpen(!menuExpanded.current);
          }}>Menu</summary>
          <nav aria-label="Mobile navigation" onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setMenuOpen(false);
          }}>
            {links.map(([label, id]) => (
              <a href={`${prefix}#${id}`} key={id} aria-current={current === id ? "location" : undefined}>
                {label}
              </a>
            ))}
            <Link href="/docs">Docs</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
