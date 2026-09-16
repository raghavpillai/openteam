import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { GithubMark } from "@/components/brand";
import { DocsLink } from "@/components/docs/docs-link";
import { CopyPage } from "@/components/docs/copy-page";
import { InlineTableOfContents, TableOfContents } from "@/components/docs/table-of-contents";
import { DocBody } from "@/components/docs/doc-body";
import { docPages } from "@/lib/docs";
import type { DocPage } from "@/lib/docs-types";

export function DocArticle({ page }: { page: DocPage }) {
  const index = docPages.findIndex((entry) => entry.slug === page.slug);
  const previous = docPages[index - 1];
  const next = docPages[index + 1];
  const headings = page.headings.filter((heading) => heading.level === 2);
  const lead = page.html.match(/^<p>[\s\S]*?<\/p>\n?/);
  const body = lead ? page.html.slice(lead[0].length) : page.html;

  return (
    <div className="docs-reading-layout">
      <main id="docs-content" className="docs-main" key={page.slug} tabIndex={-1}>
        <article>
          <header className="docs-page-header">
            <div className="docs-page-toolbar">
              <div className="docs-breadcrumbs" aria-label="Breadcrumb">
                <DocsLink href="/docs">Docs</DocsLink>
                <ChevronRight size={13} aria-hidden="true" />
                <span>{page.group}</span>
              </div>
              <CopyPage key={page.slug} markdown={page.markdown} />
            </div>
            <h1 id={page.headings[0]?.id}>{page.title}</h1>
            {lead && <div className="docs-prose docs-lead" dangerouslySetInnerHTML={{ __html: lead[0] }} />}
          </header>
          {headings.length > 1 && <InlineTableOfContents headings={headings} />}
          {/* HTML is compiled from checked-in Markdown, with raw HTML escaped. */}
          <DocBody html={body} />
        </article>
        <div className="docs-source">
          <a href={page.sourceUrl} target="_blank" rel="noreferrer">
            <GithubMark /> View source on GitHub <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
        <nav className="docs-pagination" aria-label="Adjacent pages">
          {previous ? (
            <DocsLink href={previous.href} className="docs-previous">
              <ArrowLeft size={17} aria-hidden="true" />
              <span>
                <small>Previous</small>
                {previous.title}
              </span>
            </DocsLink>
          ) : (
            <span />
          )}
          {next && (
            <DocsLink href={next.href} className="docs-next">
              <span>
                <small>Next</small>
                {next.title}
              </span>
              <ArrowRight size={17} aria-hidden="true" />
            </DocsLink>
          )}
        </nav>
      </main>
      {headings.length > 0 && (
        <aside className="docs-toc">
          <TableOfContents key={page.slug} headings={headings} />
        </aside>
      )}
    </div>
  );
}
