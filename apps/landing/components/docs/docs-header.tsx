import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { GithubMark, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";

export function DocsHeader({ repository }: { repository: string }) {
  return (
    <header className="docs-header">
      <div className="docs-container docs-header-inner">
        <Link href="/" aria-label="OpenTeam home" className="docs-brand">
          <Wordmark size={30} textSize={23} />
        </Link>
        <nav aria-label="Site navigation" className="docs-header-actions">
          <a href={repository} className="docs-github" aria-label="OpenTeam on GitHub">
            <GithubMark /><span>GitHub</span>
          </a>
          <Button className="docs-install" render={<Link href="/download" />} nativeButton={false}>
            Get OpenTeam <ArrowUpRight size={15} aria-hidden="true" />
          </Button>
        </nav>
      </div>
    </header>
  );
}
