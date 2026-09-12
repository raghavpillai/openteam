import { ArrowUpRight } from "lucide-react";
import { GithubMark, Wordmark } from "./brand";
import { Button } from "./ui/button";
import "./site-header.css";

const GITHUB = "https://github.com/raghavpillai/openteam";

export function SiteHeader({ home = false }: { home?: boolean }) {
  const prefix = home ? "" : "/";
  const links = [
    ["Demo", "product"],
    ["Plugins", "plugins"],
    ["Use cases", "how-it-works"],
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
        <details className="ot-mobile-menu">
          <summary>Menu</summary>
          <nav aria-label="Mobile navigation">
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
