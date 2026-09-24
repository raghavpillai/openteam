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

  test("returns useful starting points without a query", () => {
    expect(search("")[0].title).toBe("Quickstart");
    expect(search(" ")).toEqual(search(""));
    expect(search("", 3)).toHaveLength(3);
  });

  test("ranks exact titles first and matches case-insensitively", () => {
    expect(search("GOOGLE")[0].href).toBe("/docs/integrations/google");
    expect(search("remote access")[0].href).toBe("/docs/configuration/remote-access");
    expect(search("installation")[0].href).toBe("/docs/getting-started/installation");
  });

  test("matches prefixes, missing letters, replacements, and transpositions", () => {
    expect(search("goog")[0].href).toBe("/docs/integrations/google");
    expect(search("gogle")[0].href).toBe("/docs/integrations/google");
    expect(search("goofle")[0].href).toBe("/docs/integrations/google");
    expect(search("googel")[0].href).toBe("/docs/integrations/google");
    expect(search("instalation")[0].href).toBe("/docs/getting-started/installation");
  });

  test("searches body text, tables, and code with direct section links", () => {
    expect(search("oauth callback")[0].href).toBe("/docs/integrations/accounts#sign-in-callback");
    expect(search("8787").some((entry) => entry.href.endsWith("#requirements"))).toBe(true);
    expect(search("OPENTEAM_HOME").some((entry) => entry.href.endsWith("#where-openteam-is-installed"))).toBe(true);
    expect(search("how do I install OpenTeam").some((entry) => entry.href.includes("/getting-started/installation#"))).toBe(true);
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
