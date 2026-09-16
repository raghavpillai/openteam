import { DocsNavigation } from "@/components/docs/docs-navigation";
import { DocsHeader } from "@/components/docs/docs-header";
import { docPages, docsConfig } from "@/lib/docs";
import "./docs.css";
import "./search.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const groups = docsConfig.groups.map((group) => ({
    title: group.title,
    pages: group.pages.map((entry) => {
      const page = docPages.find((page) => page.file === entry.file)!;
      return { title: page.title, href: page.href };
    }),
  }));
  return (
    <div className="ot-docs" id="top">
      <a href="#docs-content" className="docs-skip">
        Skip to content
      </a>
      <DocsHeader repository={docsConfig.repository} />
      <div className="docs-layout">
        <DocsNavigation groups={groups} />
        {children}
      </div>
    </div>
  );
}
