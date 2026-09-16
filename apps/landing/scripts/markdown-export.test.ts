import { expect, test } from "bun:test";
import { Marked } from "marked";
import { exportMarkdown } from "./markdown-export";

test("resolves nested and reference links while preserving fenced and inline code", () => {
  const source = '# Test\n\n[Reference][guide]\n\n[guide]: ../guide.md\n\n> **[Nested](../nested.md)**\n\n1. [First](../first.md)\n   - [Child](../child.md)\n\n```md\n[Do not rewrite](../guide.md)\n```\n\n`[Literal](../guide.md)`\n\n| Column |\n| --- |\n| [Cell](../cell.md) |\n';
  const output = exportMarkdown(source, (href) => new URL(href, "https://example.com/docs/current/").href);
  expect(output).toContain("[Reference](https://example.com/docs/guide.md)");
  expect(output).toContain("> **[Nested](https://example.com/docs/nested.md)**");
  expect(output).toContain("[Child](https://example.com/docs/child.md)");
  expect(output).toContain("```md\n[Do not rewrite](../guide.md)\n```");
  expect(output).toContain("`[Literal](../guide.md)`");
  expect(output).toContain("[Cell](https://example.com/docs/cell.md)");
  const html = new Marked().parse(output) as string;
  expect(html).toContain("<table>");
  expect(html).toContain("<ol>");
  expect(html).toContain("<ul>");
});
