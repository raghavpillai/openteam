import { describe, expect, test } from "bun:test";
import { compileDocs } from "../scripts/build-docs";
import { buildDocsSearchIndex } from "../scripts/docs-search-index";
import { createDocsSearch } from "./docs-search";

const { pages } = compileDocs();
const index = buildDocsSearchIndex(pages);
const search = createDocsSearch(index);

describe("client documentation search", () => {
  test("indexes every page and resolves every section to a rendered heading", () => {
    expect(index.entries).toHaveLength(pages.reduce((count, page) => count + page.headings.length, 0));
    expect(index.entries.filter((entry) => !entry.href.includes("#"))).toHaveLength(pages.length);
    for (const entry of index.entries) {
      const [href, hash] = entry.href.split("#");
      const page = pages.find((page) => page.href === href);
      expect(page).toBeDefined();
      if (hash) expect(page!.headings.some((heading) => heading.id === hash)).toBe(true);
    }
  });

  test("matches prefixes, missing letters, replacements, and transpositions", () => {
    expect(search("goog")[0].href).toBe("/docs/integrations/google");
    expect(search("gogle")[0].href).toBe("/docs/integrations/google");
    expect(search("goofle")[0].href).toBe("/docs/integrations/google");
    expect(search("googel")[0].href).toBe("/docs/integrations/google");
    expect(search("instalation")[0].href).toBe("/docs/getting-started/installation");
  });

  test("requires all significant terms and handles arbitrary input safely", () => {
    expect(search("google qzxwvvnomatch")).toEqual([]);
    expect(search("[]()*+?")).toBeDefined();
    expect(() => search("__proto__ constructor")).not.toThrow();
    expect(() => search("x".repeat(10000))).not.toThrow();
  });

  test("keeps results bounded, diverse, and snippets near the matching text", () => {
    const results = search("server");
    expect(results.length).toBeLessThanOrEqual(8);
    const counts = new Map<string, number>();
    for (const result of results) {
      const page = result.href.split("#")[0];
      counts.set(page, (counts.get(page) ?? 0) + 1);
      expect(result.snippet.length).toBeLessThanOrEqual(177);
      expect(result.matches.length).toBeGreaterThan(0);
    }
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(search("callback")[0].snippet.toLowerCase()).toContain("callback");
  });
});
