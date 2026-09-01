import { describe, expect, test } from "bun:test";
import {
  boundedMobileAccessibilitySummary,
  boundedMobileMarkdownPreview,
  messageNeedsAdvancedMobileMarkdown,
  messageNeedsMobileMarkdown,
  parseInlineMarkdown,
  parseMobileMarkdown,
  shouldRenderRichMobileMarkdown,
} from "../src/mobile-markdown-core";

describe("bounded mobile Markdown", () => {
  test("detects indented fences and standalone rules", () => {
    expect(messageNeedsMobileMarkdown("   ```ts\nconst value = 1;\n```")).toBe(true);
    expect(messageNeedsMobileMarkdown("---")).toBe(true);
    expect(parseMobileMarkdown("   ## Indented heading")[0]).toMatchObject({
      type: "heading",
      text: "Indented heading",
    });
  });

  test("keeps ordinary Markdown structure and source-position keys", () => {
    const blocks = parseMobileMarkdown(
      "## Status\n\n- repeated\n- repeated\n\n> **Ready**\n\n```ts\nconst ok = true;\n```"
    );

    expect(blocks.map(({ type }) => type)).toEqual(["heading", "list", "quote", "code"]);
    const list = blocks[1];
    expect(list?.type).toBe("list");
    if (list?.type !== "list") throw new Error("Expected the list fixture to parse as a list");
    expect(list.items.map(({ text }) => text)).toEqual(["repeated", "repeated"]);
    expect(new Set(list.items.map(({ key }) => key)).size).toBe(2);
    expect(blocks.every(({ key }) => key.length < 24)).toBe(true);
  });

  test("tokenizes repeated links once and refuses unsafe destinations", () => {
    const tokens = parseInlineMarkdown(
      "[OpenBot](https://openbot.dev) and [OpenBot](https://openbot.dev) [unsafe](javascript:alert(1))"
    );
    const links = tokens.filter((token) => token.type === "link");

    expect(links).toHaveLength(2);
    expect(links.map(({ text }) => text)).toEqual(["OpenBot", "OpenBot"]);
    expect(new Set(tokens.map(({ key }) => key)).size).toBe(tokens.length);
    expect(tokens.map(({ text }) => text).join("")).toContain("[unsafe](javascript:alert(1))");
  });

  test("falls back to one text node before pathological content is parsed", () => {
    const maxSizedList = `${"- bounded stress row\n".repeat(10_000)}end`.slice(0, 200_000);
    const startedAt = performance.now();

    expect(messageNeedsMobileMarkdown(maxSizedList)).toBe(true);
    expect(shouldRenderRichMobileMarkdown(maxSizedList)).toBe(false);
    const preview = boundedMobileMarkdownPreview(maxSizedList);
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(2_000);
    expect(preview.text.split("\n")).toHaveLength(16);
    expect(performance.now() - startedAt).toBeLessThan(20);
  });

  test("preserves rich rendering for normal chat-sized content", () => {
    expect(
      shouldRenderRichMobileMarkdown(
        "A short paragraph with **strong text**, `code`, and [a link](https://openbot.dev)."
      )
    ).toBe(true);
  });

  test("routes tables, math, and Mermaid through the advanced renderer", () => {
    expect(
      messageNeedsAdvancedMobileMarkdown("| Name | State |\n| --- | --- |\n| Bot | Ready |")
    ).toBe(true);
    expect(messageNeedsAdvancedMobileMarkdown("Energy is $E = mc^2$.")).toBe(true);
    expect(messageNeedsAdvancedMobileMarkdown("$$\\int_0^1 x^2 dx$$")).toBe(true);
    expect(messageNeedsAdvancedMobileMarkdown("```mermaid\ngraph TD\n A-->B\n```")).toBe(true);
    expect(messageNeedsAdvancedMobileMarkdown("A normal price is $12.00 today.")).toBe(false);
  });

  test("bounds screen-reader summaries for pathological messages", () => {
    const content = `${"Accessible stress row\n".repeat(10_000)}end`;
    const summary = boundedMobileAccessibilitySummary(content);

    expect(summary.length).toBeLessThanOrEqual(401);
    expect(summary.split("\n")).toHaveLength(4);
    expect(summary.endsWith("…")).toBe(true);
    expect(boundedMobileAccessibilitySummary("Short message")).toBe("Short message");
  });
});
