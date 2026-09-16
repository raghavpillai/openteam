import { notFound, permanentRedirect } from "next/navigation";
import { DocArticle } from "@/components/docs/doc-article";
import { docPages, docsConfig, getDocPage } from "@/lib/docs";
import { pageMetadata } from "@/lib/page-metadata";

type Props = { params: Promise<{ slug: string[] }> };

export function generateStaticParams() {
  return docPages.map((page) => ({ slug: page.slug.split("/") }));
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const page = getDocPage(slug.join("/"));
  if (!page) return {};
  return pageMetadata({
    title: `${page.title} | OpenTeam ${docsConfig.title}`,
    description: page.description,
    path: page.href,
  });
}

export default async function DocumentationPage({ params }: Props) {
  const { slug } = await params;
  const page = getDocPage(slug.join("/"));
  if (!page) notFound();
  if (page.slug === docsConfig.home) permanentRedirect("/docs");
  return <DocArticle page={page} />;
}
