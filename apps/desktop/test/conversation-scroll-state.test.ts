import { describe, expect, test } from "bun:test";
import { resolveConversationScrollRestore } from "../src/renderer/lib/conversation-scroll-state";

const stored = {
  bottomDistance: 800,
  historyGeneration: 4,
  messageId: "message-20",
  viewportOffset: 17,
};

describe("conversation identity scroll restoration", () => {
  test("restores the retained message and within-row viewport offset", () => {
    expect(
      resolveConversationScrollRestore({
        currentGeneration: 4,
        messageIds: ["message-10", "message-20", "message-30"],
        stored,
      })
    ).toEqual({ index: 1, kind: "message", viewportOffset: 17 });
  });

  test("falls back to latest when the generation or identity is gone", () => {
    expect(
      resolveConversationScrollRestore({
        currentGeneration: 5,
        messageIds: ["message-20"],
        stored,
      })
    ).toEqual({ kind: "latest" });
    expect(
      resolveConversationScrollRestore({
        currentGeneration: 4,
        messageIds: ["message-10", "message-30"],
        stored,
      })
    ).toEqual({ kind: "latest" });
  });
});
