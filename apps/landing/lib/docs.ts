import data from "../.generated/docs.json";
import type { DocsData } from "./docs-types";

export const { config: docsConfig, pages: docPages } = data as DocsData;

export function getDocPage(slug: string) {
  return docPages.find((page) => page.slug === slug);
}
