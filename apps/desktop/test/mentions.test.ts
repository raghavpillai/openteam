import { describe, expect, test } from "bun:test";
import {
  mentionHandleFor,
  mentionPlainText,
  mentionRichText,
} from "../src/renderer/lib/mentions";

describe("OpenTeam-compatible mentions", () => {
  test("uses the compact lowercase name as the routed handle", () => {
    expect(mentionHandleFor("Parity Probe v3")).toBe("parityprobev3");
  });

  test("persists mention chips as OpenTeam-compatible flattened ProseMirror text", () => {
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

});
