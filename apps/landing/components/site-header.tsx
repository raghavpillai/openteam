"use client";

import { ArrowUpRight } from "lucide-react";
import { useRef } from "react";
import { GithubMark, Wordmark } from "./brand";
import { Button } from "./ui/button";
import "./site-header.css";

const GITHUB = "https://github.com/raghavpillai/openteam";

export function SiteHeader({ home = false }: { home?: boolean }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const prefix = home ? "" : "/";
  const links = [
    ["How it works", "how-it-works"],
    ["Use cases", "use-cases"],
    ["Plugins", "plugins"],
    ["Open source", "open-source"],
  ];
  return (
    <header className="ot-header ot-site-header">
      <div className="ot-container ot-nav">
        <a href={home ? "#top" : "/"} aria-label="OpenTeam home" className="ot-wordmark">
          <Wordmark size={36} textSize={24} animated />
        </a>
        <nav aria-label="Main navigation" className="ot-nav-links">
          {links.map(([label, id]) => (
            <a href={`${prefix}#${id}`} key={id}>
              {label}
            </a>
          ))}
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
              <a href={`${prefix}#${id}`} key={id}>
                {label}
              </a>
            ))}
            <a href={`${prefix}#faq`}>FAQ</a>
          </nav>
        </details>
      </div>
    </header>
  );
}
