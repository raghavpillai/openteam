"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  const [current, setCurrent] = useState("");
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
        menu.current.open = false;
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, []);
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
        <details className="ot-mobile-menu" ref={menu} onKeyDown={(event) => {
          if (event.key === "Escape" && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}>
          <summary>Menu</summary>
          <nav aria-label="Mobile navigation" onClick={(event) => {
            if ((event.target as HTMLElement).closest("a") && menu.current) menu.current.open = false;
          }}>
            {links.map(([label, id]) => (
              <a href={`${prefix}#${id}`} key={id} aria-current={current === id ? "location" : undefined}>
                {label}
              </a>
            ))}
            <a href={`${prefix}#faq`}>FAQ</a>
            <Link href="/docs">Docs</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
