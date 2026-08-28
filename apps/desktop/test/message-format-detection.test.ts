import { describe, expect, test } from "bun:test";
import { messageNeedsMarkdown } from "../src/renderer/components/ai-elements/message";

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
});
