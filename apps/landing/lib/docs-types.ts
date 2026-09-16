export type DocsConfig = {
  title: string;
  description: string;
  repository: string;
  branch: string;
  home: string;
  groups: { title: string; pages: { title: string; file: string }[] }[];
};

export type DocPage = {
  title: string;
  description: string;
  group: string;
  slug: string;
  href: string;
  file: string;
  sourceUrl: string;
  markdown: string;
  html: string;
  headings: { id: string; title: string; level: number }[];
};

export type DocsData = { config: DocsConfig; pages: DocPage[] };

// Replaced with the request origin when serving prebuilt text, including previews.
export const DOCS_ORIGIN = "https://openteam-docs.invalid";
export type DocsTextData = { pages: Record<string, string>; index: string; full: string };
