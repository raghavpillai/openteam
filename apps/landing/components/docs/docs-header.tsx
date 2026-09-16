import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { GithubMark, Wordmark } from "@/components/brand";
import { DocsLink } from "./docs-link";
import { DocsSidebarToggle } from "./docs-shell";

export function DocsHeader({ repository }: { repository: string }) {
  return (
    <header className="docs-header">
      <div className="docs-container docs-header-inner">
        <div className="docs-header-identity">
          <DocsSidebarToggle />
          <Link href="/" aria-label="OpenTeam home" className="docs-brand">
            <Wordmark size={30} textSize={23} />
          </Link>
          <span className="docs-brand-divider" aria-hidden="true" />
          <DocsLink href="/docs" className="docs-header-label">Docs</DocsLink>
        </div>
        <nav aria-label="Site navigation" className="docs-header-actions">
          <DocsLink href="/docs/getting-started/quickstart" className="docs-header-quickstart">Quickstart</DocsLink>
          <a href={repository} className="docs-github" aria-label="OpenTeam on GitHub">
            <GithubMark /><span>GitHub</span>
          </a>
          <Link href="/download" className="docs-install">
            Get OpenTeam <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </nav>
      </div>
    </header>
  );
}
