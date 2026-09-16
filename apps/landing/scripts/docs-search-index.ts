import { Marked, type Token } from "marked";
import type { DocPage } from "../lib/docs-types";
import { searchWords, type DocsSearchIndex, type SearchEntry } from "../lib/docs-search";

function tokenText(token: Token): string {
  if (token.type === "list") return token.items.map(tokenText).join(" ");
  if (token.type === "table") return [...token.header, ...token.rows.flat()].map((cell) => cell.tokens.map(tokenText).join("")).join(" ");
  if ("tokens" in token && token.tokens) return token.tokens.map(tokenText).join(token.type === "paragraph" ? "" : " ");
  return "text" in token ? token.text : " ";
}

export function buildDocsSearchIndex(pages: DocPage[]): DocsSearchIndex {
  const entries: SearchEntry[] = [];
  const parser = new Marked({ gfm: true });
  for (const page of pages) {
    let headingIndex = 0;
    let entry: SearchEntry | undefined;
    for (const token of parser.lexer(page.markdown)) {
      if (token.type === "heading") {
        const heading = page.headings[headingIndex++];
        if (!heading) throw new Error(`Missing search heading in ${page.file}`);
        entry = {
          title: heading.title,
          pageTitle: page.title,
          group: page.group,
          href: token.depth === 1 ? page.href : `${page.href}#${heading.id}`,
          text: "",
        };
        entries.push(entry);
      } else if (entry) {
        entry.text += ` ${tokenText(token)}`;
      }
    }
  }
  const terms: Record<string, number[]> = Object.create(null);
  entries.forEach((entry, id) => {
    entry.text = entry.text.replace(/\s+/g, " ").trim();
    const weights = new Map<string, number>();
    const titleWeight = Math.max(4, Math.round(12 / Math.sqrt(searchWords(entry.title).length)));
    for (const [text, weight] of [[entry.title, titleWeight], [entry.pageTitle, 5], [entry.group, 2], [entry.text, 1]] as const) {
      for (const term of new Set(searchWords(text))) weights.set(term, (weights.get(term) ?? 0) + weight);
    }
    for (const [term, weight] of weights) (terms[term] ??= []).push(id, weight);
  });
  const suggestedTitles = ["Quickstart", "Installation", "Create and manage bots", "Plugins", "Remote access"];
  const suggestions = suggestedTitles.map((title) => entries.findIndex((entry) => entry.title === title && !entry.href.includes("#"))).filter((id) => id >= 0);
  return { entries, terms, suggestions: suggestions.length ? suggestions : entries.map((_, id) => id).filter((id) => !entries[id].href.includes("#")).slice(0, 5) };
}
