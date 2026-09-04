import { describe, expect, test } from "bun:test";
import { messageNeedsMarkdown } from "../../src/renderer/components/ai-elements/message";
import {
  detectAdvancedMessageCapabilities,
  messageNeedsAdvancedRenderer,
} from "../../src/renderer/components/ai-elements/message-response/capabilities";

describe("messageNeedsMarkdown", () => {
  test("keeps identifier-heavy acknowledgements on the compact plain-text path", () => {
    expect(messageNeedsMarkdown("ACK LIVE_ACK_1787858117")).toBe(false);
    expect(messageNeedsMarkdown("OFFICIAL_WRITES_DONE")).toBe(false);
    expect(messageNeedsMarkdown("thread/compact/start -> contextCompaction")).toBe(false);
  });

  test("recognizes actual inline and block markdown", () => {
    expect(messageNeedsMarkdown("Use **this** value")).toBe(true);
    expect(messageNeedsMarkdown("Try `SendToUser` next")).toBe(true);
    expect(messageNeedsMarkdown("- first\n- second")).toBe(true);
    expect(messageNeedsMarkdown("[reference](https://example.com)")).toBe(true);
  });

  test("recognizes math that requires the advanced renderer", () => {
    expect(messageNeedsMarkdown("Solve $x + 1 = 2$ now")).toBe(true);
  });

  test("loads rich capabilities independently", () => {
    expect(detectAdvancedMessageCapabilities("Solve $x + 1 = 2$ now")).toEqual({
      cjk: false,
      code: false,
      math: true,
      mermaid: false,
    });
    expect(detectAdvancedMessageCapabilities("```ts\nconst answer = 42;\n```")).toEqual({
      cjk: false,
      code: true,
      math: false,
      mermaid: false,
    });
    expect(detectAdvancedMessageCapabilities("```mermaid\ngraph TD; A-->B\n```")).toEqual({
      cjk: false,
      code: false,
      math: false,
      mermaid: true,
    });
  });

  test("combines only the capabilities present in mixed content", () => {
    const content = "計算 $x=1$\n```mermaid\ngraph TD; A-->B\n```\n```js\nx += 1\n```";
    expect(messageNeedsAdvancedRenderer(content)).toBe(true);
    expect(detectAdvancedMessageCapabilities(content)).toEqual({
      cjk: true,
      code: true,
      math: true,
      mermaid: true,
    });
  });

  test("does not initialize math or CJK support for code content", () => {
    const content = "```sh\necho '$HOME' # 日本語 and `$x$` are code\n```";
    expect(detectAdvancedMessageCapabilities(content)).toEqual({
      cjk: false,
      code: true,
      math: false,
      mermaid: false,
    });
    expect(messageNeedsAdvancedRenderer("Use `$x$` as the literal token")).toBe(false);
  });
});
