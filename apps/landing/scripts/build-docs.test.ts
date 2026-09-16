import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileDocs, docsDirectory, validateConfig } from "./build-docs";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "openteam-docs-"));
  temporaryDirectories.push(directory);
  const docs = path.join(directory, "docs");
  mkdirSync(path.join(docs, "overview"), { recursive: true });
  mkdirSync(path.join(docs, "setup"));
  const config = {
    title: "Docs",
    description: "Test docs",
    repository: "https://github.com/example/repo",
    branch: "main",
    home: "overview/introduction",
    groups: [
      {
        title: "Start",
        pages: [
          { title: "Introduction", file: "overview/introduction.md" },
          { title: "Install", file: "setup/install.md" },
        ],
      },
    ],
  };
  writeFileSync(path.join(docs, "config.json"), JSON.stringify(config));
  writeFileSync(
    path.join(docs, "overview/introduction.md"),
    "# Introduction\n\nWelcome.\n\n[Install](../setup/install.md#install-it)\n"
  );
  writeFileSync(
    path.join(docs, "setup/install.md"),
    "# Install\n\nInstall the app.\n\n## Install it\n\n```sh\necho '<hello>'\n```\n"
  );
  return { docs, config };
}

describe("documentation build", () => {
  test("compiles every configured repository page and keeps the exact Markdown source", () => {
    const data = compileDocs();
    expect(data.pages.length).toBe(data.config.groups.flatMap((group) => group.pages).length);
    for (const page of data.pages) {
      expect(page.markdown).toBe(readFileSync(path.join(docsDirectory, page.file), "utf8"));
      expect(page.html).not.toContain("<h1");
      expect(page.description.length).toBeGreaterThan(0);
      expect(page.href).toBe(page.slug === data.config.home ? "/docs" : `/docs/${page.slug}`);
    }
  });

  test("preserves config order and rewrites GitHub-relative links to website routes", () => {
    const { docs } = fixture();
    const { pages } = compileDocs(docs);
    expect(pages.map((page) => page.title)).toEqual(["Introduction", "Install"]);
    expect(pages[0].html).toContain('href="/docs/setup/install#install-it"');
    expect(pages[1].headings.map((heading) => heading.id)).toEqual(["install", "install-it"]);
    expect(pages[1].html).toContain("&lt;hello&gt;");
  });

  test("renders GFM, escapes raw HTML, and creates unique heading anchors", () => {
    const { docs } = fixture();
    writeFileSync(
      path.join(docs, "setup/install.md"),
      "# Install\n\n## Install it\n\n## Install it\n\n| A | B |\n| --- | --- |\n| one | two |\n\n<script>alert('x')</script>\n"
    );
    const page = compileDocs(docs).pages[1];
    expect(page.headings.map((heading) => heading.id)).toEqual([
      "install",
      "install-it",
      "install-it-1",
    ]);
    expect(page.html).toContain("<table>");
    expect(page.html).toContain("&lt;script&gt;");
    expect(page.html).not.toContain("<script>");
  });

  test("rejects missing files, mismatched titles, missing pages, and broken anchors", () => {
    const { docs } = fixture();
    const intro = path.join(docs, "overview/introduction.md");
    writeFileSync(intro, "# Introduction\n\n[Missing](../setup/missing.md)\n");
    expect(() => compileDocs(docs)).toThrow("Broken link");
    writeFileSync(intro, "# Introduction\n\n[Install](../setup/install.md#missing)\n");
    expect(() => compileDocs(docs)).toThrow("Broken heading");
    writeFileSync(intro, "# Wrong title\n");
    expect(() => compileDocs(docs)).toThrow("must match config");
    rmSync(intro);
    expect(() => compileDocs(docs)).toThrow("Missing docs file");
  });

  test("rejects duplicate files, paths outside docs, and an unlisted home", () => {
    const { config } = fixture();
    expect(() => validateConfig({ ...config, home: "missing" })).toThrow("home");
    expect(() =>
      validateConfig({ ...config, groups: [...config.groups, ...config.groups] })
    ).toThrow("Duplicate");
    expect(() =>
      validateConfig({
        ...config,
        groups: [{ title: "Unsafe", pages: [{ title: "Unsafe", file: "../outside.md" }] }],
      })
    ).toThrow("Invalid docs page");
  });

  test("rejects executable URLs in Markdown", () => {
    const { docs } = fixture();
    writeFileSync(
      path.join(docs, "overview/introduction.md"),
      "# Introduction\n\n[Unsafe](javascript:alert)\n"
    );
    expect(() => compileDocs(docs)).toThrow("Unsupported URL");
  });

  test("links to repository files outside the configured navigation", () => {
    const { docs } = fixture();
    writeFileSync(path.join(docs, "../README.md"), "# Repository\n");
    writeFileSync(
      path.join(docs, "overview/introduction.md"),
      "# Introduction\n\n[Source](../../README.md)\n"
    );
    expect(compileDocs(docs).pages[0].html).toContain(
      'href="https://github.com/example/repo/blob/main/README.md"'
    );
  });
});
