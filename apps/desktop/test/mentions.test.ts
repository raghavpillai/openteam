import { describe, expect, test } from "bun:test";
import {
  mentionHandleFor,
  mentionPlainText,
  mentionRichText,
  moveMentionSelection,
  shouldRefreshMentionPickerOnKeyUp,
} from "../src/renderer/lib/mentions";

describe("Grok-compatible mentions", () => {
  test("uses the compact lowercase name as the routed handle", () => {
    expect(mentionHandleFor("Parity Probe v3")).toBe("parityprobev3");
  });

  test("persists mention chips as Grok-compatible flattened ProseMirror text", () => {
    const segments = [
      { type: "text" as const, text: "Ask " },
      {
        type: "mention" as const,
        id: "bot-1",
        label: "Parity Probe v3",
        handle: "parityprobev3",
      },
      { type: "text" as const, text: " to check\nnow" },
    ];
    expect(mentionPlainText(segments)).toBe("Ask @parityprobev3 to check\nnow");
    expect(JSON.parse(mentionRichText(segments))).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Ask @parityprobev3 to check" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "now" }] },
      ],
    });
  });

  test("moves mention selection in both directions and wraps at the ends", () => {
    expect(moveMentionSelection(0, 4, 1)).toBe(1);
    expect(moveMentionSelection(3, 4, 1)).toBe(0);
    expect(moveMentionSelection(0, 4, -1)).toBe(3);
    expect(moveMentionSelection(2, 4, -1)).toBe(1);
    expect(moveMentionSelection(0, 0, 1)).toBe(0);
  });

  test("keeps Escape dismissed across keyup without blocking ordinary caret navigation", () => {
    expect(shouldRefreshMentionPickerOnKeyUp("Escape", true)).toBe(false);
    expect(shouldRefreshMentionPickerOnKeyUp("Escape", false)).toBe(false);
    expect(shouldRefreshMentionPickerOnKeyUp("ArrowDown", true)).toBe(false);
    expect(shouldRefreshMentionPickerOnKeyUp("ArrowDown", false)).toBe(true);
    expect(shouldRefreshMentionPickerOnKeyUp("a", true)).toBe(true);
  });
});
